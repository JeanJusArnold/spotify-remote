package com.jbarnaud.spotifyremote.feature.nowplaying

import android.os.SystemClock
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.jbarnaud.spotifyremote.network.ApiService
import com.jbarnaud.spotifyremote.network.dto.QueueItemDto
import com.jbarnaud.spotifyremote.state.AudioBufferingTrigger
import com.jbarnaud.spotifyremote.state.LocalPlaybackIntentTrigger
import com.jbarnaud.spotifyremote.state.PlaybackStateRepository
import com.jbarnaud.spotifyremote.state.QueueRefreshTrigger
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.launch
import javax.inject.Inject

// server reports "m:ss" text, not seconds - matches player.js's own
// toSeconds() parsing exactly
private fun parseMinutesSeconds(text: String): Int {
    val parts = text.split(":")
    if (parts.size != 2) return 0
    val minutes = parts[0].toIntOrNull() ?: return 0
    val seconds = parts[1].toIntOrNull() ?: return 0
    return minutes * 60 + seconds
}

data class NowPlayingUiState(
    val title: String = "",
    val artist: String = "",
    val cover: String = "",
    val playing: Boolean = false,
    val positionSeconds: Int = 0,
    val durationSeconds: Int = 0,
    val shuffle: Boolean = false,
    val repeat: String = "off",
    val playPauseShielded: Boolean = false,
    val audioBuffering: Boolean = false
)

// context is the queue panel's own "À suivre dans : X" heading, not the
// now-playing bar's context link (which always points at the track's
// album even when playing from a playlist/radio) - see getContextAndQueue
// in server.js
data class QueueUiState(
    val context: String = "",
    val queue: List<QueueItemDto> = emptyList(),
    val manualQueue: List<QueueItemDto> = emptyList(),
    val isRefreshing: Boolean = false
)

@HiltViewModel
class NowPlayingViewModel @Inject constructor(
    private val apiService: ApiService,
    private val playbackStateRepository: PlaybackStateRepository,
    private val queueRefreshTrigger: QueueRefreshTrigger,
    private val localPlaybackIntentTrigger: LocalPlaybackIntentTrigger,
    private val audioBufferingTrigger: AudioBufferingTrigger
) : ViewModel() {

    private val POSITION_DISPLAY_ADVANCE_MS = 0L

    // How long the "BUFFER" overlay stays up after next/previous/playing
    // a specific track - the command lands on Spotify almost immediately,
    // but the audio anyone actually hears always trails behind it: a
    // fresh encoder spawn (see ensureEncoderRunning in server.js) plus
    // the MPRIS round trip plus a small client buffer target
    // (PlaybackService's DefaultLoadControl) before real, current audio
    // is actually flowing. A plain fixed local timer, not tied to
    // waiting for any specific real push to land - deliberately simple
    // after the earlier attempt at precisely correlating a delay with
    // real server events turned out to be a lot of complexity for little
    // payoff (see [[live_buffer_display_delay]]).
    //
    // Re-tuned 2026-08-19 for the continuous-broadcast redesign (see
    // [[continuous_audio_relay_redesign]]) - was 8000L under segmented
    // HLS. Measured live, cross-referencing server [resume-timing] logs
    // against PlaybackService's own playbackState transitions: two clean
    // resume cycles both landed at READY ~2.5s after "encoder input
    // ready", ~2.8s from the tap itself - consistently, no segment-grid
    // wait left to inflate it. Some margin kept above the raw
    // measurement for real audible sound (not just ExoPlayer's own
    // READY) and normal variance - trimmed slightly further to 3000L
    // by request, close to (but still above) the ~2.8s raw measurement.
    private val AUDIO_BUFFERING_DISPLAY_MS = 3000L

    private val _audioBuffering = MutableStateFlow(false)
    private var audioBufferingClearJob: Job? = null

    // pauseSpotifyAndEncoder in server.js keeps the real Spotify (PC)
    // position advancing for up to pauseLandsInMs after a pause tap,
    // purely to build encoder buffer for the next resume - the position
    // keeps extrapolating forward through that window too, instead of
    // freezing the instant this device's own local audio stops, so the
    // bar matches what's really still happening on the PC. Set from the
    // /pause response below; self-expiring (no explicit clear needed) -
    // once elapsedRealtime() passes it, uiState's combine just stops
    // treating it as still-advancing on its own.
    private var pauseDeadlineElapsedMs: Long? = null

    // Held slightly longer than the server's own mprisBlocked reports it
    // needs, ONLY when dropping (never when raising - the button must
    // disable itself immediately, same as before). Masks a real, known
    // cosmetic glitch: state.playing can briefly show the wrong value
    // for a few hundred ms right as mprisBlocked clears (a stale DOM
    // scrape - see server.js's own comment on pauseSpotifyAndEncoder's
    // pendingPlayingIntent reset), which flickers the revealed icon
    // (shield → wrong icon → correct icon) if the shield drops the
    // instant mprisBlocked does. Keeping the shield up a bit longer
    // means state.playing has already settled by the time it's actually
    // revealed. Purely a display delay - does NOT touch state.playing,
    // HLS re-attach, or any server-side timing (see
    // [[shield_mechanism_redesign]] for the regression cascade that
    // attempting to fix the underlying signal timing directly caused,
    // reverted the same day - this is a deliberately much lower-risk
    // alternative).
    private val SHIELD_DROP_DELAY_MS = 500L
    private val _shieldHeld = MutableStateFlow(false)
    private var shieldDropJob: Job? = null

    init {
        viewModelScope.launch {
            audioBufferingTrigger.events.collect {
                audioBufferingClearJob?.cancel()
                _audioBuffering.value = true
                audioBufferingClearJob = viewModelScope.launch {
                    delay(AUDIO_BUFFERING_DISPLAY_MS)
                    _audioBuffering.value = false
                }
            }
        }
        viewModelScope.launch {
            playbackStateRepository.state
                .map { it?.mprisBlocked ?: false }
                .distinctUntilChanged()
                .collect { blocked ->
                    shieldDropJob?.cancel()
                    if (blocked) {
                        _shieldHeld.value = true
                    } else {
                        shieldDropJob = viewModelScope.launch {
                            delay(SHIELD_DROP_DELAY_MS)
                            _shieldHeld.value = false
                        }
                    }
                }
        }
    }

    // Ticks once a second purely to re-run the combine below and
    // re-extrapolate positionSeconds - no network involved. Replaces
    // the old ~2s /state poll's own side effect of moving the progress
    // bar: now that a real push only happens on an actual event (title
    // change, play/pause, etc. - see server.js's pushStateIfChanged),
    // something still has to advance the displayed position between
    // those, and this is it.
    //
    // Restarted (via flatMapLatest) on every stateReceivedAtMs update
    // instead of ticking on its own fixed schedule - confirmed live
    // this was the actual cause of a track appearing to start ~1-1.5s
    // late compared to Spotify's own web player: an unsynced 1Hz ticker
    // means up to a full second can pass between a real push landing
    // (position correctly recomputes to 0 right away, since that part
    // already reacts to stateReceivedAtMs directly) and this ticker's
    // own next unrelated tick actually re-running the combine to show
    // it moving again - a visible stall, not a real delay. Restarting
    // the ticker itself on every push makes its first emission
    // immediate every time, so the very next real second already shows
    // up.
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private val positionTicker = playbackStateRepository.stateReceivedAtMs.flatMapLatest {
        flow {
            while (true) {
                emit(Unit)
                delay(1000)
            }
        }
    }

    val uiState = combine(
        playbackStateRepository.state,
        playbackStateRepository.stateReceivedAtMs,
        positionTicker,
        _audioBuffering,
        _shieldHeld
    ) { state, receivedAtMs, _, buffering, shielded ->
        if (state == null) {
            NowPlayingUiState(playPauseShielded = shielded, audioBuffering = buffering)
        } else {
            val durationSeconds = parseMinutesSeconds(state.duration)
            val basePositionSeconds = parseMinutesSeconds(state.position)
            // Extrapolate forward while actually playing, AND while a
            // deferred pause is still pending (real Spotify position on
            // the PC keeps advancing until pauseDeadlineElapsedMs - see
            // its own comment) - a genuinely paused track's position is
            // exactly what the last real push said and stays there until
            // something changes again.
            //
            // POSITION_DISPLAY_ADVANCE_MS nudges the extrapolation
            // forward a bit to cancel out the real pipeline latency
            // between when a position was actually true on the PC and
            // when this device receives it (MutationObserver debounce +
            // scrape + network round trip) - confirmed live the remote's
            // bar was consistently ~0.5s behind the web player's own bar
            // without this. Only applied to the ticking part, not a flat
            // shift on the paused/base value itself: a paused position is
            // exactly what's on screen in the web player too (no
            // extrapolation involved, so no latency to cancel out) -
            // adding it there would just make a paused position wrong by
            // a constant 0.5s instead of matching.
            //
            // Once past the deadline, freeze at the deadline's OWN
            // elapsed value, not at 0 - confirmed live that falling back
            // to 0 (i.e. the raw basePositionSeconds from the original
            // pause-tap push) made the bar visibly jump backward the
            // instant the deferred pause landed, then jump forward again
            // on resume once a fresh push finally corrected it. No real
            // corroborating push arrives at the exact moment a deferred
            // pause actually lands (playing was already reported false
            // at tap time, so nothing in the dedup fields changes then -
            // see pushStateIfChanged in server.js), so this device is on
            // its own for that gap.
            val nowMs = SystemClock.elapsedRealtime()
            val deadline = pauseDeadlineElapsedMs
            val elapsedMs = when {
                state.playing -> nowMs - receivedAtMs
                deadline != null -> (minOf(nowMs, deadline) - receivedAtMs).coerceAtLeast(0)
                else -> null
            }
            val elapsedSeconds = if (elapsedMs != null) {
                ((elapsedMs + POSITION_DISPLAY_ADVANCE_MS) / 1000L).toInt()
            } else {
                0
            }
            NowPlayingUiState(
                title = state.title,
                artist = state.artist,
                cover = state.cover,
                playing = state.playing,
                // coerced against durationSeconds so extrapolation drift
                // can't visibly overshoot the track's own end while
                // waiting for the real "next track" push to land
                positionSeconds = (basePositionSeconds + elapsedSeconds).coerceAtMost(durationSeconds),
                durationSeconds = durationSeconds,
                shuffle = state.shuffle,
                repeat = state.repeat,
                playPauseShielded = shielded,
                audioBuffering = buffering
            )
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), NowPlayingUiState())

    private val _queueState = MutableStateFlow(QueueUiState())
    val queueState: StateFlow<QueueUiState> = _queueState.asStateFlow()

    // matches coverTappedForCurrentAlbum: null/mismatched means "not
    // tapped yet for this album", so the tap only previews; a second tap
    // while this still equals the current cover navigates in instead.
    // Comparing lazily against the live cover at tap time (rather than a
    // separate poll-driven reset) reproduces the original's own reset
    // condition for free - state.cover !== currentAlbumCoverKey - without
    // needing a second collector here.
    private var tappedAlbumCoverKey: String? = null

    // handleCoverTap(): writeAlbumNameToSearch() always runs on every
    // tap (cheap, and the second tap's fetch is redundant but harmless -
    // same as the original); only a second tap for the SAME album
    // (cover unchanged since the first tap) also navigates in
    fun onCoverTap(onPreview: (String) -> Unit, onNavigateToAlbum: () -> Unit) {
        val cover = uiState.value.cover
        viewModelScope.launch {
            runCatching { apiService.currentAlbumName().name }.onSuccess(onPreview)
        }
        if (tappedAlbumCoverKey != null && tappedAlbumCoverKey == cover) {
            onNavigateToAlbum()
        } else {
            tappedAlbumCoverKey = cover
        }
    }

    // matches playResult()/closeSearch() both resetting
    // coverTappedForCurrentAlbum when the player view becomes visible
    // again - called from NowPlayingScreen's own LaunchedEffect(Unit),
    // which reruns every time this screen (re)enters composition,
    // exactly the cases where the original's two reset call sites fire
    fun onScreenEntered() {
        tappedAlbumCoverKey = null
    }

    // matches updateState()'s own gating exactly: refreshContextAndQueue()
    // fires either when the polled title actually changes (not on every
    // 2s tick - reading the queue panel requires opening it server-side,
    // real work not worth doing on every poll), OR when
    // queuedWhileOverlayOpen was set by a successful add elsewhere (see
    // QueueRefreshTrigger - a title change alone would never happen from
    // that). The original also skips both while its search overlay is
    // open or a browse load is in flight, since neither the context line
    // nor the queue lists are visible then anyway - this ViewModel only
    // exists while NowPlayingScreen itself is the visible destination,
    // so that same "not currently visible" case already means this whole
    // class isn't even instantiated, with no separate check needed.
    init {
        viewModelScope.launch {
            merge(
                playbackStateRepository.state.mapNotNull { it?.title }.distinctUntilChanged().map {},
                queueRefreshTrigger.events
            ).collect { refreshQueue() }
        }
    }

    // The "À suivre" section is the one always rendered regardless of
    // manual-queue state (see QueueRow/NowPlayingScreen's own comment on
    // #manualQueueSection.visible), so it's where the pull gesture lives
    // - and since a single /context-and-queue call refreshes both lists
    // together, pulling there also recovers a manual-queue add made
    // directly on the Web Player instead of through this app (see
    // [[queue_external_webplayer_edits]] - this is the manual fallback
    // for that same gap, added after the user asked for one rather than
    // leaving it as a pure known-limitation).
    fun refreshQueueManually() {
        viewModelScope.launch {
            _queueState.update { it.copy(isRefreshing = true) }
            refreshQueue()
            _queueState.update { it.copy(isRefreshing = false) }
        }
    }

    private suspend fun refreshQueue() {
        runCatching { apiService.contextAndQueue() }.onSuccess { data ->
            _queueState.value = QueueUiState(data.context, data.queue, data.manualQueue)
        }
    }

    fun onQueueItemClick(index: Int, listType: String, item: QueueItemDto) {
        audioBufferingTrigger.notifyTrackChangeRequested()
        viewModelScope.launch {
            runCatching { apiService.queuePlay(index, listType, item.title, item.subtitle) }
        }
    }

    // removing shifts every later index, and neither queue list is tied
    // to the currently-playing title, so nothing else would trigger a
    // refresh on its own - force one now, matching the original's own
    // lastQueueSignature = ""; refreshContextAndQueue() pairing
    fun onQueueRemove(index: Int, listType: String) {
        viewModelScope.launch {
            runCatching { apiService.queueRemove(index, listType) }
            refreshQueue()
        }
    }

    // PlaybackService's /state-stream WebSocket connection is what
    // actually keeps playbackStateRepository.state current now - every
    // route below already pushes its own result server-side
    // (pushStateIfChanged in server.js), so there's no separate
    // "refresh after this action" step needed here anymore the way
    // there was under polling.

    // not a toggle server-side - /state's playing field already
    // reflects pending intent immediately after a call (see
    // pendingPlayingIntent in server.js), so the latest polled value is
    // safe to use directly to decide direction
    fun onPlayPauseClick() {
        val playing = playbackStateRepository.state.value?.playing ?: return
        viewModelScope.launch {
            if (playing) {
                // Stops the local ExoPlayer immediately instead of
                // waiting for the real state push to confirm it -
                // always safe, there's nothing to wait for when
                // stopping. See RemoteControlPlayer.play()'s own
                // comment for why the same isn't done on the resume
                // branch below: attaching before the server's new
                // encoder generation actually exists just fetches a
                // stale manifest and makes the resulting silence
                // longer, not shorter - confirmed live.
                localPlaybackIntentTrigger.requestPlaying(false)
                // Catches the 409 mpris_blocked backstop (see
                // StateResponse.mprisBlocked's own comment) - the button
                // should already be disabled whenever this could happen,
                // so a rejection here means the tap raced ahead of that,
                // nothing meaningful to surface for it.
                try {
                    val response = apiService.pause()
                    pauseDeadlineElapsedMs = SystemClock.elapsedRealtime() + response.pauseLandsInMs
                } catch (e: Exception) { /* mpris_blocked backstop - see comment above */ }
            } else {
                // Not wired to this button before the continuous-relay
                // redesign - a resume genuinely spawns a fresh encoder
                // server-side now (see ensureEncoderRunning in
                // server.js), the same real audio gap next/previous
                // already covers, so it earns the same overlay.
                audioBufferingTrigger.notifyTrackChangeRequested()
                try {
                    apiService.play()
                } catch (e: Exception) { /* mpris_blocked backstop - see comment above */ }
            }
        }
    }

    fun onNext() {
        audioBufferingTrigger.notifyTrackChangeRequested()
        fire { apiService.next() }
    }

    fun onPrevious() {
        audioBufferingTrigger.notifyTrackChangeRequested()
        fire { apiService.previous() }
    }

    fun onShuffleClick() = fire { apiService.shuffle() }
    fun onRepeatClick() = fire { apiService.repeat() }

    fun onSeek(percent: Float) {
        // Same real gap as next/previous/playing a specific track (see
        // AudioBufferingTrigger's own comment) - a seek lands on Spotify
        // almost immediately, but the audio actually heard trails the
        // live edge by ~HLS_SEGMENT_SECONDS, so there's a real wait
        // before what's audible matches the new position.
        audioBufferingTrigger.notifyTrackChangeRequested()
        val durationSeconds = playbackStateRepository.state.value?.duration?.let(::parseMinutesSeconds)
        if (durationSeconds != null) {
            playbackStateRepository.applyLocalSeek((percent * durationSeconds).toInt())
        }
        fire { apiService.seek(percent) }
    }

    // Crashed the whole app 2026-08-19 on a real SocketTimeoutException
    // (network hiccup reaching the server) - an uncaught exception in a
    // launch{} block crashes the process, same class of bug pause()/
    // play() above already guard against.
    private fun fire(call: suspend () -> Unit) {
        viewModelScope.launch {
            try {
                call()
            } catch (e: Exception) { /* transient network failure - nothing to surface for a fire-and-forget action */ }
        }
    }

}
