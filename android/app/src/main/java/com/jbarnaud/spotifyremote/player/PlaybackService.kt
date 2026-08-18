package com.jbarnaud.spotifyremote.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.getSystemService
import androidx.core.graphics.drawable.toBitmap
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.MediaStyleNotificationHelper
import coil.ImageLoader
import coil.request.ImageRequest
import coil.request.SuccessResult
import com.jbarnaud.spotifyremote.MainActivity
import com.jbarnaud.spotifyremote.R
import com.jbarnaud.spotifyremote.network.ApiService
import com.jbarnaud.spotifyremote.network.dto.StateResponse
import com.jbarnaud.spotifyremote.settings.SettingsRepository
import com.jbarnaud.spotifyremote.state.LocalPlaybackIntentTrigger
import com.jbarnaud.spotifyremote.state.PlaybackStateRepository
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.decodeFromString
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.ByteArrayOutputStream
import javax.inject.Inject

private const val TAG = "PlaybackService"
private const val INITIAL_RETRY_DELAY_MS = 2000L
private const val MAX_RETRY_DELAY_MS = 30_000L
private const val WS_INITIAL_RETRY_DELAY_MS = 1000L
private const val WS_MAX_RETRY_DELAY_MS = 30_000L
private const val NOTIFICATION_CHANNEL_ID = "playback"
private const val NOTIFICATION_ID = 1

// Owns ExoPlayer, the MediaSession, AND the /state-stream WebSocket
// connection.
//
// History (see the project plan / native_app_migration memory for the
// full milestone breakdown): state sync started as a plain /state poll
// loop, Activity-lifecycle-bound in NowPlayingViewModel - confirmed live
// to stop once the screen slept. Moved to this Service, but a plain
// started Service is *itself* subject to Android's background execution
// limits - confirmed live too (dumpsys showed the service gone after
// enough idle time). Became a real foreground service with a
// notification to survive that. The poll loop itself was later replaced
// with this WebSocket connection (see connectStateStream) once it
// turned out most of what it was polling for could instead be pushed
// server-side the moment it actually changes - see
// [[dual_instance_hls_handoff]]/server.js's own pushStateIfChanged for
// the server half of this. ExoPlayer was also confirmed to never
// auto-recover from a playback error on its own (drops to STATE_IDLE
// and just sits there) - ties into scheduleRetry() below. This class is
// where all of that lands.
//
// Extends MediaSessionService (not a plain Service) specifically so the
// system - lock screen, Bluetooth AVRCP, notification, Android Auto -
// can discover and drive playback through a real MediaSession, the same
// as any other music app, rather than the hand-rolled plain notification
// this used before.
@AndroidEntryPoint
class PlaybackService : MediaSessionService() {

    @Inject
    lateinit var playbackStateRepository: PlaybackStateRepository

    @Inject
    lateinit var settingsRepository: SettingsRepository

    @Inject
    lateinit var apiService: ApiService

    @Inject
    lateinit var localPlaybackIntentTrigger: LocalPlaybackIntentTrigger

    @Inject
    lateinit var okHttpClient: OkHttpClient

    @Inject
    lateinit var json: Json

    // MediaSessionService isn't a LifecycleOwner (unlike the
    // LifecycleService this used before) - own scope instead, cancelled
    // in onDestroy
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private lateinit var player: ExoPlayer
    private lateinit var mediaSession: MediaSession

    private var lastMetadataTitle: String? = null

    // set once by attachMediaSource, re-read on resume to rebuild the
    // media source fresh rather than just prepare() the existing one
    private var currentBaseUrl: String? = null

    private var retryDelayMs = INITIAL_RETRY_DELAY_MS
    private var retryJob: Job? = null

    // /state-stream connection state - see connectStateStream's own
    // comment for the reconnect strategy
    private var stateSocket: WebSocket? = null
    private var wsRetryDelayMs = WS_INITIAL_RETRY_DELAY_MS
    private var wsReconnectJob: Job? = null

    // Loaded once per cover URL and reused across notification rebuilds -
    // MediaStyle needs an actual Bitmap for the large artwork, unlike
    // Compose's AsyncImage which can take a URL directly.
    private val imageLoader by lazy { ImageLoader(this) }
    private var currentArtwork: Bitmap? = null
    private var artworkJob: Job? = null

    override fun onCreate() {
        super.onCreate()

        // startForegroundService() (AppRoot.kt) requires startForeground()
        // to land within ~5s or the system kills the whole process with a
        // ForegroundServiceDidNotStartInTimeException - confirmed live
        // (dropbox crash reports, 2026-08-13/14) after the player/session
        // setup below (ExoPlayer.Builder, Hilt-injected deps) was slow
        // enough to blow past it under real-world conditions. Call it here
        // with a placeholder first, before any of that work, so the SLA
        // is met unconditionally; updateNotification() below swaps in the
        // real MediaStyle notification once the session actually exists.
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildPlaceholderNotification())

        player = ExoPlayer.Builder(this)
            // Neither of these was set before - confirmed live: pairing
            // a Bluetooth output device mid-playback (SBC/AAC codec
            // handshake, audio route handoff) can leave the AudioTrack
            // wedged with no thrown PlaybackException (onPlayerError
            // below never fires for it), requiring a manual app restart
            // to recover. handleAudioFocus=true makes ExoPlayer actually
            // react to the transient focus requests that routing changes
            // like this can trigger instead of silently ignoring them;
            // handleAudioBecomingNoisy gives a clean pause/resume cycle
            // around a route change instead of pushing straight through
            // whatever the AudioTrack does with it. onStateReceived's own
            // playWhenReady resync (rather than a separately-tracked
            // "last known" flag) is what makes a local-only pause from
            // either of these self-heal on the next pushed state instead
            // of silently diverging from the server's still-"playing"
            // state.
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true
            )
            .setHandleAudioBecomingNoisy(true)
            .setLoadControl(
                // nothing here ever seeks backward - bounds memory
                // growth over a long session, analog of hlsListen.js's
                // backBufferLength: 30
                DefaultLoadControl.Builder()
                    .setBackBuffer(30_000, true)
                    .build()
            )
            .build()

        player.addListener(object : Player.Listener {

            override fun onPlayerError(error: PlaybackException) {
                // confirmed live: ExoPlayer does NOT auto-recover from a
                // playback error on its own - it drops to STATE_IDLE and
                // just sits there. Left a real 10-minute session
                // permanently silent after a transient
                // PlaylistStuckException, even though the server/stream
                // itself was fine again moments later. player.prepare()
                // is the documented way to retry the same already-set
                // media item after an error.
                Log.e(TAG, "ExoPlayer error: ${error.errorCodeName}", error)
                scheduleRetry()
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                val name = when (playbackState) {
                    Player.STATE_IDLE -> "IDLE"
                    Player.STATE_BUFFERING -> "BUFFERING"
                    Player.STATE_READY -> "READY"
                    Player.STATE_ENDED -> "ENDED"
                    else -> "UNKNOWN($playbackState)"
                }
                Log.i(TAG, "playbackState=$name position=${player.currentPosition} duration=${player.duration}")

                // back to healthy - forget any backoff built up from
                // earlier errors, so a later, separate incident starts
                // retrying quickly again instead of picking up where a
                // now-irrelevant previous one left off
                if (playbackState == Player.STATE_READY) {
                    retryDelayMs = INITIAL_RETRY_DELAY_MS
                }
            }

            // keeps the notification's play/pause affordance and
            // "ongoing" (swipe-to-dismiss) state in sync - MediaStyle
            // reads the session's current commands each time the
            // notification is rebuilt, it doesn't push updates on its
            // own since notification posting is done manually here
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                updateNotification()
            }
        })

        mediaSession = MediaSession.Builder(this, RemoteControlPlayer(player))
            .setSessionActivity(
                android.app.PendingIntent.getActivity(
                    this,
                    0,
                    Intent(this, MainActivity::class.java),
                    android.app.PendingIntent.FLAG_IMMUTABLE
                )
            )
            .build()

        // Reverted from relying on MediaSessionService's automatic
        // notification handling - confirmed live it's unreliable on this
        // device (no notification ever appeared, and the service itself
        // vanished from dumpsys within minutes). Manually posting instead,
        // now built with MediaStyleNotificationHelper's MediaStyle for the
        // real "Media Player" look (system treats it as a media
        // notification: big artwork, transport buttons wired to the
        // MediaSession, shows on the lock screen) - the placeholder posted
        // at the top of onCreate() satisfied the startForeground() SLA,
        // this swaps in the real thing now that mediaSession exists.
        updateNotification()

        // See LocalPlaybackIntentTrigger's own comment - the local half
        // of a play/pause tap, applied immediately rather than waiting
        // for the poll loop above to notice the server's own new value.
        localPlaybackIntentTrigger.events
            .onEach { playing -> if (player.playWhenReady != playing) applyLocalPlaying(playing) }
            .launchIn(serviceScope)

        settingsRepository.currentBaseUrl
            .filterNotNull()
            .distinctUntilChanged()
            .onEach {
                attachMediaSource(it)
                connectStateStream(it)
            }
            .launchIn(serviceScope)

        playbackStateRepository.state
            .filterNotNull()
            .onEach(::onStateReceived)
            .launchIn(serviceScope)

        // No periodic ping on the WebSocket itself (see NetworkModule's
        // own comment on why that was mostly redundant with Tailscale's
        // own keepalive) - instead, force a fresh reconnect the moment
        // the app comes back to the foreground, which is the only time
        // a stale connection would actually be noticed (stale
        // notification/lock-screen metadata isn't something anyone's
        // looking at while backgrounded). drop(1) skips the very first
        // STARTED transition at cold start, already covered by the
        // baseUrl-driven initial connect above - this only reacts to
        // genuine "was backgrounded, now isn't" transitions.
        ProcessLifecycleOwner.get().lifecycle.currentStateFlow
            .map { it.isAtLeast(Lifecycle.State.STARTED) }
            .distinctUntilChanged()
            .drop(1)
            .filter { it }
            .onEach { currentBaseUrl?.let(::connectStateStream) }
            .launchIn(serviceScope)

    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = mediaSession

    // MediaSessionService's own default onTaskRemoved calls stopSelf()
    // based on isPlaybackOngoing(), which checks whether Media3's OWN
    // MediaNotificationManager started the foreground service - but this
    // service manages startForeground()/its notification manually (see
    // buildPlaceholderNotification/updateNotification below), never
    // through that manager, so that check is always false regardless of
    // real playback state. Confirmed live: swiping the app away always
    // killed the session/notification immediately, even mid-playback -
    // unlike other music apps, which keep the notification alive
    // (manually dismissable by the user) as long as something's actually
    // playing. Overridden to check the real player state instead.
    override fun onTaskRemoved(rootIntent: Intent?) {
        if (!player.isPlaying) {
            stopSelf()
        }
    }

    // Wraps the real ExoPlayer so the system's transport controls (lock
    // screen, notification, Bluetooth headset buttons, Android Auto)
    // drive the *server*, not the local HLS relay directly - this
    // player only ever plays back what the server says is playing, it
    // has no independent authority over Spotify itself. Mirrors exactly
    // what NowPlayingViewModel's on-screen buttons already do (same
    // /play, /pause, /next, /previous calls, plus the same immediate
    // localPlaybackIntentTrigger call on pause only - see its own
    // comment for why play deliberately doesn't do the same).
    private inner class RemoteControlPlayer(player: Player) : ForwardingPlayer(player) {

        override fun play() {
            // No local intent fired here, unlike pause - confirmed live
            // this made the post-pause silence LONGER, not shorter:
            // firing it stopping instantly is always safe (there's
            // nothing to wait for), but resuming isn't - the server
            // hasn't necessarily spawned the new encoder generation yet
            // at the exact instant this is tapped, so attaching
            // immediately could fetch the OLD, now-stale manifest before
            // the new one exists, and ExoPlayer's own retry/backoff for
            // live-manifest fetches only made that worse than just
            // waiting for the real state push once the server (and its
            // fresh encoder) is actually ready.
            serviceScope.launch { apiService.play() }
        }

        override fun pause() {
            // read directly off the player rather than through
            // PlaybackStateRepository's copy - this call already has
            // the real instance at hand, no reason to use a value that
            // can be up to one poll tick stale
            val offset = player.currentLiveOffset
            val liveOffsetMs = if (offset != C.TIME_UNSET) offset else 0L
            localPlaybackIntentTrigger.requestPlaying(false)
            serviceScope.launch { apiService.pause(liveOffsetMs) }
        }

        override fun seekToNext() {
            serviceScope.launch { apiService.next() }
        }

        override fun seekToPrevious() {
            serviceScope.launch { apiService.previous() }
        }

    }

    private fun attachMediaSource(baseUrl: String) {

        currentBaseUrl = baseUrl

        Log.i(TAG, "Attaching HLS source at $baseUrl/hls/stream.m3u8")

        val mediaItem = MediaItem.Builder()
            .setUri("$baseUrl/hls/stream.m3u8")
            .setLiveConfiguration(
                // ~1 segment behind live - server.js's HLS_SEGMENT_SECONDS
                // (4s as of 2026-08-15, shortened from 6s specifically to
                // cut down the silence at each dual-instance handoff - see
                // [[dual_instance_hls_handoff]]; keep this in sync with it)
                MediaItem.LiveConfiguration.Builder()
                    .setTargetOffsetMs(4000)
                    .build()
            )
            .build()

        player.setMediaItem(mediaItem)
        player.prepare()

    }

    // Replaces the old /state poll loop - connects once per baseUrl and
    // just sits there; server.js pushes a fresh state down the instant
    // it actually changes (see pushStateIfChanged there), instead of
    // this having to ask on any fixed schedule. Reconnects with the same
    // exponential-backoff shape as scheduleRetry() below on any drop
    // (server restart, Tailscale hiccup, phone's own network handoff) -
    // deliberately NOT gated on app foreground/visibility the way the
    // old poll loop briefly was: unlike polling, an idle WebSocket
    // costs essentially nothing on its own (no traffic at all until the
    // server actually has something to say), so there's no tradeoff
    // left to gate on - staying connected in the background is what
    // keeps the notification/lock screen metadata correct across a
    // track change while the phone is asleep, at no extra ongoing cost
    // for the common case where nothing changes for minutes at a time.
    private fun connectStateStream(baseUrl: String) {

        wsReconnectJob?.cancel()
        // stateSocket cleared BEFORE cancelling, not after - confirmed
        // live this was a real race, not just theoretical: cancel()
        // delivers the old listener's onFailure asynchronously, on the
        // old socket's own reader thread, and that could - and did -
        // land in the brief window between cancel() and stateSocket
        // being reassigned to the new socket below, while stateSocket
        // still pointed at the very socket that was failing. The
        // onFailure/onClosed guards below compare against stateSocket
        // to ignore a stale listener, which only works if it's already
        // cleared before the old socket has any chance to report in.
        val old = stateSocket
        stateSocket = null
        old?.cancel()

        val request = Request.Builder().url("$baseUrl/state-stream").build()
        stateSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "/state-stream connected")
                wsRetryDelayMs = WS_INITIAL_RETRY_DELAY_MS
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { json.decodeFromString<StateResponse>(text) }
                    .onSuccess { playbackStateRepository.updateState(it) }
                    .onFailure { Log.e(TAG, "bad /state-stream message: $text", it) }
            }

            // Both guarded against a stale listener - confirmed live:
            // stateSocket?.cancel() above (deliberately replacing an
            // old connection, e.g. the foreground reconnect check)
            // makes the OLD socket's own read loop throw, which OkHttp
            // reports as this same onFailure on the OLD listener,
            // moments after the NEW one was already assigned to
            // stateSocket. Without this check, that stale callback
            // scheduled its own reconnect on top of the fresh
            // connection that had just been deliberately established,
            // racing to tear it down again a second later for no
            // reason.
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (webSocket !== stateSocket) return
                Log.w(TAG, "/state-stream failed, reconnecting", t)
                scheduleWsReconnect(baseUrl)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== stateSocket) return
                Log.i(TAG, "/state-stream closed ($code $reason), reconnecting")
                scheduleWsReconnect(baseUrl)
            }

        })

    }

    private fun scheduleWsReconnect(baseUrl: String) {
        wsReconnectJob?.cancel()
        wsReconnectJob = serviceScope.launch {
            delay(wsRetryDelayMs)
            wsRetryDelayMs = (wsRetryDelayMs * 2).coerceAtMost(WS_MAX_RETRY_DELAY_MS)
            connectStateStream(baseUrl)
        }
    }

    // Shared by onStateReceived's own idempotent sync (the WebSocket
    // connection above eventually receiving the server's new value) and
    // localPlaybackIntentTrigger's collector (a tap moving the local
    // player immediately, independent of that push's own timing) - both
    // need the exact same handling, not just a playWhenReady flip.
    private fun applyLocalPlaying(playing: Boolean) {
        if (playing) {
            // Every real resume spawns a genuinely new encoder
            // generation server-side, with its own init segment and
            // fresh segment numbering (see [[dual_instance_hls_handoff]])
            // - re-attaching instead of just flipping playWhenReady
            // forces ExoPlayer to drop whatever stale period/timeline
            // state it was holding and fetch that new generation's
            // manifest fresh, jumping to ITS live edge. Confirmed live:
            // after pausing and leaving the app backgrounded for a
            // while, a bare playWhenReady=true played out only the
            // already-buffered deferred-pause segments and then went
            // silent - ExoPlayer never discovered the new generation's
            // content on its own, apparently because its live-manifest
            // refresh backs off the longer it sits idle/paused.
            currentBaseUrl?.let { attachMediaSource(it) }
            player.playWhenReady = true
        } else {
            player.playWhenReady = false
            // ExoPlayer's live-manifest refresh keeps polling on its own
            // ~4s cadence even with playWhenReady=false - confirmed via
            // server [traffic] logs showing manifest GETs continuing
            // indefinitely after pause, at nearly the same radio cost as
            // actual streaming (segment fetches are what stopped, not the
            // poll itself). stop() tears down the HLS loader entirely,
            // so nothing polls until the next real resume, which already
            // rebuilds a fresh source from scratch via attachMediaSource
            // above regardless of whether this ran.
            player.stop()
        }
    }

    private fun onStateReceived(state: StateResponse) {

        // idempotent - only act on an actual transition. Calling
        // play()/pause() unconditionally on every received state
        // previously caused audible stutter/looping in the web client
        // and must not be repeated here. Compared against the player's
        // OWN current playWhenReady (not a separately-tracked "last
        // known server state" flag) so a local-only pause - audio focus
        // loss, becoming-noisy, or any other reason the player stopped
        // itself without the server knowing - self-heals on the next
        // pushed state instead of staying silently diverged until some
        // unrelated future transition happens to flip state.playing
        // again.
        if (player.playWhenReady != state.playing) {
            applyLocalPlaying(state.playing)
        }

        // feeds the on-screen pause button's shield-margin decision
        // (see NowPlayingViewModel.onPlayPauseClick and
        // pauseSpotifyAndEncoder in server.js) - TIME_UNSET before the
        // live window is established, skip the update rather than
        // overwrite a real prior value with garbage
        val liveOffsetMs = player.currentLiveOffset
        if (liveOffsetMs != C.TIME_UNSET) {
            playbackStateRepository.updateCurrentLiveOffsetMs(liveOffsetMs)
        }

        if (lastMetadataTitle != state.title) {
            lastMetadataTitle = state.title
            val updatedItem = player.currentMediaItem?.buildUpon()
                ?.setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(state.title)
                        .setArtist(state.artist)
                        .setArtworkUri(android.net.Uri.parse(state.cover))
                        .build()
                )
                ?.build()
            if (updatedItem != null) {
                // metadata-only change on the already-playing item -
                // confirmed via a live logcat capture across a real
                // track change: "Attaching HLS" (attachMediaSource) never
                // re-fires for this
                player.replaceMediaItem(0, updatedItem)
            }

            loadArtworkAndUpdate(state.cover, state.title, state.artist)
        }

    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "Lecture en cours",
            NotificationManager.IMPORTANCE_LOW
        )
        getSystemService<NotificationManager>()?.createNotificationChannel(channel)
    }

    // Posted once, immediately in onCreate(), before player/mediaSession
    // exist - must not touch either. Swapped out for the real MediaStyle
    // notification (buildNotification()) as soon as they're ready.
    private fun buildPlaceholderNotification(): Notification {
        val openAppIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Spotify Remote")
            .setContentText("Connexion en cours...")
            .setContentIntent(openAppIntent)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun buildNotification(): Notification {
        val metadata = player.mediaMetadata
        val openAppIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(metadata.title)
            .setContentText(metadata.artist)
            .setLargeIcon(currentArtwork)
            .setContentIntent(openAppIntent)
            .setOngoing(player.isPlaying)
            .setOnlyAlertOnce(true)
            .setStyle(MediaStyleNotificationHelper.MediaStyle(mediaSession))
            .build()
    }

    private fun updateNotification() {
        if (!::mediaSession.isInitialized) return
        getSystemService<NotificationManager>()?.notify(NOTIFICATION_ID, buildNotification())
    }

    // Coil loads straight into a Bitmap here (no Compose involved, unlike
    // NowPlayingScreen's AsyncImage) since MediaStyle's large icon needs
    // an actual Bitmap up front, not a URL it can resolve itself.
    private fun loadArtworkAndUpdate(url: String?, title: String?, artist: String?) {
        artworkJob?.cancel()
        if (url.isNullOrBlank()) {
            currentArtwork = null
            updateNotification()
            return
        }
        artworkJob = serviceScope.launch {
            val result = imageLoader.execute(
                ImageRequest.Builder(this@PlaybackService).data(url).build()
            )
            val artwork = (result as? SuccessResult)?.drawable?.toBitmap()
            currentArtwork = artwork
            updateNotification()

            // MediaSession's legacy bridge (MediaSessionLegacyStub, used
            // for Bluetooth AVRCP / Android Auto) can't fetch an
            // artworkUri itself - confirmed via a logged
            // FileNotFoundException, it only opens content://file://
            // URIs, never http(s). Re-set the metadata with the already-
            // loaded bitmap attached as artworkData (raw compressed
            // bytes), which it reads directly instead of trying to
            // resolve the URI.
            if (artwork != null) {
                val updatedItem = player.currentMediaItem?.buildUpon()
                    ?.setMediaMetadata(
                        MediaMetadata.Builder()
                            .setTitle(title)
                            .setArtist(artist)
                            .setArtworkUri(Uri.parse(url))
                            .setArtworkData(
                                ByteArrayOutputStream().also { stream ->
                                    artwork.compress(Bitmap.CompressFormat.JPEG, 90, stream)
                                }.toByteArray(),
                                MediaMetadata.PICTURE_TYPE_FRONT_COVER
                            )
                            .build()
                    )
                    ?.build()
                if (updatedItem != null) {
                    player.replaceMediaItem(0, updatedItem)
                }
            }
        }
    }

    // Exponential backoff (2s, 4s, 8s... capped at 30s) rather than a
    // fixed delay - a single transient hiccup recovers quickly, but a
    // genuinely broken server/network doesn't get hammered with retries
    // forever. Reset back to the initial delay happens in
    // onPlaybackStateChanged once STATE_READY is actually reached again.
    private fun scheduleRetry() {
        retryJob?.cancel()
        retryJob = serviceScope.launch {
            delay(retryDelayMs)
            Log.i(TAG, "Retrying playback after error (waited ${retryDelayMs}ms)")
            player.prepare()
            retryDelayMs = (retryDelayMs * 2).coerceAtMost(MAX_RETRY_DELAY_MS)
        }
    }

    override fun onDestroy() {
        stateSocket?.cancel()
        mediaSession.release()
        player.release()
        serviceScope.cancel()
        super.onDestroy()
    }

}
