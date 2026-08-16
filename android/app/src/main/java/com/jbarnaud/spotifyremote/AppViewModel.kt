package com.jbarnaud.spotifyremote

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.jbarnaud.spotifyremote.feature.browse.BrowseTarget
import com.jbarnaud.spotifyremote.network.ApiService
import com.jbarnaud.spotifyremote.settings.SettingsRepository
import com.jbarnaud.spotifyremote.state.LoadingIndicatorController
import com.jbarnaud.spotifyremote.state.SharedLinkController
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class AppViewModel @Inject constructor(
    settingsRepository: SettingsRepository,
    loadingIndicatorController: LoadingIndicatorController,
    private val apiService: ApiService,
    sharedLinkController: SharedLinkController
) : ViewModel() {
    val currentBaseUrl = settingsRepository.currentBaseUrl
    val isLoaded = settingsRepository.isLoaded

    // drives SpotifyRemoteHeader's isLoading with the real signal from
    // every browse/search network call (see LoadingIndicatorController),
    // replacing the old fixed-3.5s-after-tap approximation
    val isBrowseLoading = loadingIndicatorController.isLoading

    // one-shot events, not state - a StateFlow would re-navigate/re-toast
    // on every later collector (e.g. a config change) that happens to
    // observe the last value again. extraBufferCapacity so an event
    // emitted before AppRoot's LaunchedEffect starts collecting (cold
    // start via a share/link intent) still arrives instead of being
    // dropped.
    private val _navigationTarget = MutableSharedFlow<BrowseTarget>(extraBufferCapacity = 1)
    val navigationTarget: SharedFlow<BrowseTarget> = _navigationTarget.asSharedFlow()

    private val _snackbarMessage = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val snackbarMessage: SharedFlow<String> = _snackbarMessage.asSharedFlow()

    // a track link resolving while the user is sitting in Search/Browse
    // (not Now Playing) would otherwise autoplay silently behind whatever
    // screen is on top - confirmed live: the Snackbar alone isn't enough,
    // the user has no way to actually see/react to the new track without
    // manually backing out themselves. Matches playItem()'s own onPlayed()
    // behavior for tapping a track search result - same "just played
    // something, go look at it" outcome, just reached via a resolved link
    // instead of a tap.
    private val _returnToNowPlaying = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val returnToNowPlaying: SharedFlow<Unit> = _returnToNowPlaying.asSharedFlow()

    // matches the web client's openSharedLink() exactly: a track is
    // already autoplaying server-side by the time /resolve-link returns
    // (see server.js), so there's nothing to navigate to, just an
    // acknowledgment; artist/album/playlist go straight to that entity's
    // own screen - the same place tapping a search result for it would
    // land, without an extra confirmation tap in between since resolving
    // the link already told us exactly where the user meant to go.
    // Podcast links (episode/show) have no screen anywhere in this app
    // (search never returns them either) - surfaced as an error, not a
    // silent no-op, since a native app has no console to fall back on.
    init {
        viewModelScope.launch {
            sharedLinkController.links.collect { raw -> resolveSharedLink(raw) }
        }
    }

    private suspend fun resolveSharedLink(raw: String) {
        val response = runCatching { apiService.resolveLink(raw) }.getOrNull()
        val item = response?.takeIf { it.isSuccessful }?.body()

        when {
            item == null -> _snackbarMessage.tryEmit("Lien Spotify introuvable ou illisible")
            item.type == "track" -> {
                _snackbarMessage.tryEmit("Lecture du morceau partagé")
                _returnToNowPlaying.tryEmit(Unit)
            }
            item.type == "artist" -> _navigationTarget.tryEmit(BrowseTarget.Artist(item.id, item.title, item.cover))
            item.type == "album" -> _navigationTarget.tryEmit(BrowseTarget.Album(item.id, item.title, item.cover))
            item.type == "playlist" -> _navigationTarget.tryEmit(BrowseTarget.Playlist(item.id, item.title, item.cover))
            else -> _snackbarMessage.tryEmit("Type de contenu non pris en charge")
        }
    }
}
