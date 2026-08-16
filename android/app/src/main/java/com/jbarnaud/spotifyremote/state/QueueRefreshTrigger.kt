package com.jbarnaud.spotifyremote.state

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import javax.inject.Inject
import javax.inject.Singleton

// Matches queuedWhileOverlayOpen in player.js: updateState() only
// refreshes the queue panel when the playing title itself changes
// (NowPlayingViewModel's own title-change collector already handles
// that) - queueing a track from a Browse/Search row doesn't change the
// title at all, so without this, a successful add never shows up until
// the next real track change happens to trigger a refresh anyway. This
// is the second, independent trigger the original ORs in alongside the
// title check, as a plain cross-ViewModel signal since BrowseViewModel/
// SearchViewModel (where the add happens) and NowPlayingViewModel (which
// owns the queue lists) have no other reference to each other.
@Singleton
class QueueRefreshTrigger @Inject constructor() {

    private val _events = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val events: SharedFlow<Unit> = _events.asSharedFlow()

    fun requestRefresh() {
        _events.tryEmit(Unit)
    }

}
