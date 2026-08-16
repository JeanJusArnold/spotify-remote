package com.jbarnaud.spotifyremote.state

import android.os.SystemClock
import com.jbarnaud.spotifyremote.network.dto.StateResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

// Single source of truth for the latest known playback state - written
// by PlaybackService's /state-stream WebSocket connection (see its own
// comment) whenever the server actually pushes something, not on any
// fixed schedule. This repository is a passive holder anything can
// read.
@Singleton
class PlaybackStateRepository @Inject constructor() {

    private val _state = MutableStateFlow<StateResponse?>(null)
    val state: StateFlow<StateResponse?> = _state.asStateFlow()

    // SystemClock.elapsedRealtime() at the moment _state was last set -
    // paired with state.position (itself only as fresh as the last real
    // push) so the UI can extrapolate a smoothly advancing position
    // locally between real events instead of needing network traffic
    // just to keep a progress bar moving. elapsedRealtime, not
    // currentTimeMillis, since this is purely an elapsed-time
    // calculation that must not jump if the wall clock does.
    private val _stateReceivedAtMs = MutableStateFlow(0L)
    val stateReceivedAtMs: StateFlow<Long> = _stateReceivedAtMs.asStateFlow()

    fun updateState(newState: StateResponse) {
        _state.value = newState
        _stateReceivedAtMs.value = SystemClock.elapsedRealtime()
    }

    // A drag-to-seek only reaches the server (real Spotify position,
    // scraped back down through the DOM observer/push - see
    // pushStateIfChanged in server.js) after a real round trip; without
    // this, the displayed position kept extrapolating from wherever it
    // was before the drag until that push eventually landed, ignoring
    // the seek entirely in the meantime. Overwrites just the position
    // text and resets the extrapolation baseline to right now, keeping
    // every other field (title, playing, etc.) as last known - the next
    // real push still overwrites this the moment it arrives, same as
    // any other optimistic update in this app.
    fun applyLocalSeek(positionSeconds: Int) {
        val current = _state.value ?: return
        val minutes = positionSeconds / 60
        val seconds = positionSeconds % 60
        _state.value = current.copy(position = "%d:%02d".format(minutes, seconds))
        _stateReceivedAtMs.value = SystemClock.elapsedRealtime()
    }

    // Last known Player.getCurrentLiveOffset() from PlaybackService (the
    // only place with a real ExoPlayer instance) - written whenever it
    // changes there, read here by whichever screen calls /pause so the
    // server's deferred-pause margin can adapt to it. PlaybackService's
    // own MediaSession pause path reads player.currentLiveOffset
    // directly instead of through here, since it already has the player
    // at hand.
    private val _currentLiveOffsetMs = MutableStateFlow(0L)
    val currentLiveOffsetMs: StateFlow<Long> = _currentLiveOffsetMs.asStateFlow()

    fun updateCurrentLiveOffsetMs(offsetMs: Long) {
        _currentLiveOffsetMs.value = offsetMs
    }

}
