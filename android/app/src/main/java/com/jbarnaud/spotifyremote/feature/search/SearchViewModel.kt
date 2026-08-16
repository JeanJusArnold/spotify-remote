package com.jbarnaud.spotifyremote.feature.search

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.jbarnaud.spotifyremote.feature.browse.BrowseTarget
import com.jbarnaud.spotifyremote.feature.browse.BrowseUiState
import com.jbarnaud.spotifyremote.network.ApiService
import com.jbarnaud.spotifyremote.network.dto.BrowseItem
import com.jbarnaud.spotifyremote.state.AudioBufferingTrigger
import com.jbarnaud.spotifyremote.state.LoadingIndicatorController
import com.jbarnaud.spotifyremote.state.QueueRefreshTrigger
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

// Search owns live user text input, so it doesn't fit BrowseViewModel's
// nav-args-driven model - reuses BrowseUiState/BrowseResultsList for
// rendering, but drives its own fetch on submit rather than on init.
//
// Ported from the original's real mechanism (public/js/player.js's
// librarySearchShortcuts/updateSearchGhost/doSearch), not a generic
// replacement for it: "p"/"ar"/"al" are French abbreviations
// (Playlists/Artistes/Albums, author-specific, not a general
// convention) and "n" is "Nouveautés" - typing one of these and
// submitting routes straight into library/what's-new browsing instead
// of running a real search, and the ghost/label maps below drive an
// inline gray text preview of the matched shortcut's full label as you
// type it.
private val librarySearchShortcuts = mapOf("p" to "playlists", "ar" to "artists", "al" to "albums")
private val librarySearchShortcutLabels = mapOf("p" to "Playlists", "ar" to "Artistes", "al" to "Albums", "n" to "Nouveautés")

@HiltViewModel
class SearchViewModel @Inject constructor(
    private val apiService: ApiService,
    private val loadingIndicator: LoadingIndicatorController,
    private val queueRefreshTrigger: QueueRefreshTrigger,
    private val audioBufferingTrigger: AudioBufferingTrigger
) : ViewModel() {

    var query by mutableStateOf("")
        private set

    // the part of the matched shortcut's label not yet typed - "" when
    // the current query doesn't match a shortcut at all. Mirrors
    // updateSearchGhost()'s ghostSuggestion.innerText exactly.
    var ghostSuggestion by mutableStateOf("")
        private set

    // distinguishes "nothing searched yet" (show a blank screen) from
    // "searched, got zero results" (BrowseResultsList's own "Aucun
    // résultat") - without this, an isLoading=false/items=empty initial
    // BrowseUiState is indistinguishable from a genuine empty result
    var hasSearched by mutableStateOf(false)
        private set

    private val _uiState = MutableStateFlow(BrowseUiState(isLoading = false))
    val uiState: StateFlow<BrowseUiState> = _uiState.asStateFlow()

    private var searchJob: Job? = null

    fun onQueryChange(newQuery: String) {
        query = newQuery
        val label = librarySearchShortcutLabels[newQuery.trim().lowercase()]
        ghostSuggestion = label?.substring(newQuery.trim().length) ?: ""
    }

    // matches cancelLoadOrClose/closeSearch's input-clearing half - the
    // X button lives on the bar itself now (embedded in NowPlaying, not
    // a screen with its own back navigation), so there's no separate
    // "close" destination to pop; clearing the field in place is the
    // whole of it
    fun onClear() {
        searchJob?.cancel()
        query = ""
        ghostSuggestion = ""
    }

    // matches doSearch() exactly: a shortcut match short-circuits into
    // library/what's-new browsing before ever touching the real search
    // endpoint, and only a real query needs the caller to navigate to a
    // results screen at all
    fun onSearch(onNavigate: (BrowseTarget) -> Unit, onRealSearch: () -> Unit) {

        val q = query.trim()
        if (q.isEmpty()) return

        val libraryType = librarySearchShortcuts[q.lowercase()]
        if (libraryType != null) {
            onNavigate(BrowseTarget.Library(libraryType))
            return
        }

        if (q.lowercase() == "n") {
            onNavigate(BrowseTarget.WhatsNew)
            return
        }

        onRealSearch()
        hasSearched = true

        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            loadingIndicator.track {
                runCatching { apiService.search(q) }
                    .onSuccess { results -> _uiState.update { it.copy(isLoading = false, items = results) } }
                    .onFailure { _uiState.update { it.copy(isLoading = false, error = "Erreur de recherche") } }
            }
        }

    }

    // folders never appear in search results (they're a library-sidebar-
    // only concept), so unlike BrowseViewModel.onItemClick there's no
    // "folder" case to handle here
    fun onItemClick(item: BrowseItem, onNavigate: (BrowseTarget) -> Unit, onPlayed: () -> Unit) {
        when (item.type) {
            "artist" -> onNavigate(BrowseTarget.Artist(item.id, item.title, item.cover))
            "album" -> onNavigate(BrowseTarget.Album(item.id, item.title, item.cover))
            "playlist" -> onNavigate(BrowseTarget.Playlist(item.id, item.title, item.cover))
            else -> playItem(item.id, onPlayed)
        }
    }

    private fun playItem(id: String, onPlayed: () -> Unit) {
        audioBufferingTrigger.notifyTrackChangeRequested()
        viewModelScope.launch {
            runCatching { apiService.playResult(id) }
            onPlayed()
        }
    }

    // see BrowseViewModel.addToQueue's own comment for why
    // QueueRefreshTrigger is needed here too
    suspend fun addToQueue(id: String): Boolean {
        val ok = runCatching { apiService.queueAdd(id) }.getOrNull()?.isSuccessful == true
        if (ok) queueRefreshTrigger.requestRefresh()
        return ok
    }

}
