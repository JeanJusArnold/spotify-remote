package com.jbarnaud.spotifyremote.state

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

// Ports the original web client's currentAbortController/
// beginAbortableLoad/endAbortableLoad (public/js/player.js) - the real
// trigger behind the topbar's "fake" typing/fill animation
// (SpotifyRemoteHeader's isLoading). There, EVERY browse/search network
// call across the whole single-page app (doSearch, browseArtist,
// browseAlbum, browsePlaylist, browseWhatsNew, browseLibrary,
// browseLibraryFolder, browseCurrentArtist, browseCurrentAlbum,
// browseHome, loadMorePlaylistTracks, loadMoreLibraryTracks,
// loadHomeSection, goBackInLibrary) starts/stops the same single global
// flag around its own request - here that's BrowseViewModel.load()/
// loadMore()/onHomeSectionToggle() and SearchViewModel's real (non-
// shortcut) search, each instance calling begin()/end() the same way.
//
// A counter, not a plain boolean: the original tracks one single
// AbortController and cancels+replaces it on every new call, so there's
// never truly more than one in flight and a plain on/off flag is exact
// there. Nothing here cancels an older ViewModel-owned coroutine when a
// newer screen starts loading (those are separate ViewModel instances
// with their own scopes, unlike the original's one global controller),
// so two calls can legitimately overlap - the counter keeps the
// indicator on until every one of them has actually finished, instead
// of an early end() from a faster call turning it off while a slower
// one is still running.
@Singleton
class LoadingIndicatorController @Inject constructor() {

    private var activeCount = 0
    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    fun begin() {
        activeCount++
        _isLoading.value = true
    }

    fun end() {
        activeCount = (activeCount - 1).coerceAtLeast(0)
        _isLoading.value = activeCount > 0
    }

    // convenience wrapper for the common begin()-try-end() shape every
    // call site below needs
    suspend fun <T> track(block: suspend () -> T): T {
        begin()
        try {
            return block()
        } finally {
            end()
        }
    }

}
