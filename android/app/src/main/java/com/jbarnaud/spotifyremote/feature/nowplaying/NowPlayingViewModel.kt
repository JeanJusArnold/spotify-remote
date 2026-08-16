package com.jbarnaud.spotifyremote.feature.nowplaying

import android.os.SystemClock
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.jbarnaud.spotifyremote.network.ApiService
import com.jbarnaud.spotifyremote.network.dto.QueueItemDto
import com.jbarnaud.spotifyremote.player.ShieldController
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

    private val shieldController = ShieldController(viewModelScope)

    private val POSITION_DISPLAY_ADVANCE_MS = 1000L

    // How long the "BUFFER" overlay stays up after next/previous/playing
    // a specific track - matches HLS_SEGMENT_SECONDS/PlaybackService's
    // own setTargetOffsetMs: the command lands on Spotify almost
    // immediately, but the audio anyone actually hears always trails the
    // live edge by about this much, so this is roughly how long the real
    // audio result takes to arrive regardless of how fast the network
    // round trip itself is. A plain fixed local timer, not tied to
    // waiting for any specific real push to land - deliberately simple
    // after the earlier attempt at precisely correlating a delay with
    // real server events turned out to be a lot of complexity for little
    // payoff (see [[live_buffer_display_delay]]).
    private val AUDIO_BUFFERING_DISPLAY_MS = 8000L

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
        shieldController.isShielded,
        playbackStateRepository.stateReceivedAtMs,
        positionTicker,
        _audioBuffering
    ) { state, shielded, receivedAtMs, _, buffering ->
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
                val liveOffsetMs = playbackStateRepository.currentLiveOffsetMs.value
                val response = apiService.pause(liveOffsetMs)
                pauseDeadlineElapsedMs = SystemClock.elapsedRealtime() + response.pauseLandsInMs
                shieldController.armBracketed(response.pauseLandsInMs)
            } else {
                val response = apiService.play()
                shieldController.armWholeDuration(response.shieldMs)
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
        val durationSeconds = playbackStateRepository.state.value?.duration?.let(::parseMinutesSeconds)
        if (durationSeconds != null) {
            playbackStateRepository.applyLocalSeek((percent * durationSeconds).toInt())
        }
        fire { apiService.seek(percent) }
    }

    private fun fire(call: suspend () -> Unit) {
        viewModelScope.launch { call() }
    }

}
