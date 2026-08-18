package com.jbarnaud.spotifyremote.state

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import javax.inject.Inject
import javax.inject.Singleton

// Fired by any action that changes what track is playing (next,
// previous, playing a specific track from the queue/Browse/Search) -
// NowPlayingViewModel is the sole subscriber, showing a "BUFFER" overlay
// for a fixed window afterward. Unlike playPauseShielded (which mirrors
// the server's real mprisBlocked state to protect the play/pause button
// itself during a narrow danger window - see StateResponse.mprisBlocked),
// this has nothing to do with button safety - it exists purely to
// explain a real, separate lag: the command lands on Spotify quickly,
// but the audio anyone actually hears is always ~HLS_SEGMENT_SECONDS
// behind the live edge (see PlaybackService's own setTargetOffsetMs), so
// there's always a real gap between "the app says the new track" and
// "you can hear it". A plain cross-ViewModel signal, same shape as
// [[QueueRefreshTrigger]], since BrowseViewModel/SearchViewModel (where
// playing a specific track happens) and NowPlayingViewModel (which owns
// the overlay) have no other reference to each other.
@Singleton
class AudioBufferingTrigger @Inject constructor() {

    private val _events = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val events: SharedFlow<Unit> = _events.asSharedFlow()

    fun notifyTrackChangeRequested() {
        _events.tryEmit(Unit)
    }

}
