package com.jbarnaud.spotifyremote.feature.browse

import android.net.Uri
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.jbarnaud.spotifyremote.navigation.browseTargetFromArgs
import com.jbarnaud.spotifyremote.network.ApiService
import com.jbarnaud.spotifyremote.network.NdjsonClient
import com.jbarnaud.spotifyremote.network.dto.BrowseItem
import com.jbarnaud.spotifyremote.network.dto.DiscographyChunk
import com.jbarnaud.spotifyremote.network.dto.LibraryMoreChunk
import com.jbarnaud.spotifyremote.network.dto.PlaylistMoreChunk
import com.jbarnaud.spotifyremote.state.AudioBufferingTrigger
import com.jbarnaud.spotifyremote.state.LoadingIndicatorController
import com.jbarnaud.spotifyremote.state.PlaybackStateRepository
import com.jbarnaud.spotifyremote.state.QueueRefreshTrigger
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class HomeSectionUi(
    val index: Int,
    val heading: String,
    val expanded: Boolean = false,
    val items: List<BrowseItem>? = null // null = not loaded yet
)

data class BrowseUiState(
    val locationLabel: String = "",
    val isLoading: Boolean = true,
    val error: String? = null,
    val items: List<BrowseItem> = emptyList(),
    val singles: List<BrowseItem> = emptyList(),
    val compilations: List<BrowseItem> = emptyList(),
    val sections: List<HomeSectionUi> = emptyList(),
    val canLoadMore: Boolean = false,
    val isLoadingMore: Boolean = false
)

// Drives every non-Search browse screen (artist/current-artist/album/
// current-album/playlist/library/library-folder/home/whats-new) from a
// single generic implementation, parameterized by the BrowseTarget
// decoded from this instance's own nav args.
//
// Each distinct navigation destination gets its own ViewModel instance
// (standard Compose Navigation per-back-stack-entry scoping), so
// hasLoadedOnce below correctly tracks "first time showing this exact
// screen" vs "returning to it via back" per instance, not globally.
//
// Why onResumed() re-fetches rather than trusting the cached uiState as-
// is: the server's Playwright page is real, shared, mutable state - not
// just a data source. Browsing into something (an artist's own album,
// deeper into a library folder) actually navigates the one real Spotify
// page server-side. Going back in THIS app's nav stack doesn't undo
// that. If a cached screen were shown without re-syncing and the user
// then tapped a browsable row in it, the server would try to find that
// row's link on whatever page it's CURRENTLY sitting on (quite possibly
// a different one by then) and fail. The web client (player.js) avoids
// this by unconditionally re-fetching everything on every goBack() -
// ported here as "re-run this screen's own fetch on every resume, not
// just the first time." Library/LibraryFolder use /library-back instead
// of /library or /library-folder on a re-sync specifically, matching
// goBackInLibrary's exitFolder logic exactly - re-clicking a folder or
// re-selecting a chip would also work, but /library-back is the
// narrower, more direct "just resync" call the server exposes for this.
@HiltViewModel
class BrowseViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val apiService: ApiService,
    private val ndjsonClient: NdjsonClient,
    private val playbackStateRepository: PlaybackStateRepository,
    private val loadingIndicator: LoadingIndicatorController,
    private val queueRefreshTrigger: QueueRefreshTrigger,
    private val audioBufferingTrigger: AudioBufferingTrigger
) : ViewModel() {

    val target: BrowseTarget = browseTargetFromArgs(
        kind = savedStateHandle.get<String>("kind")!!,
        id = savedStateHandle.get<String>("id") ?: "-",
        title = Uri.decode(savedStateHandle.get<String>("title") ?: ""),
        cover = Uri.decode(savedStateHandle.get<String>("cover") ?: "")
    )

    // matches applyFallbackCovers(results, fallbackCover) in the
    // original - individual tracks inside an album/playlist scrape (and
    // sometimes an artist's own albums/singles/compilations) often don't
    // carry their own cover, so every row would otherwise render with no
    // thumbnail at all. CurrentAlbum/CurrentArtist have no nav-args
    // cover to fall back on (they're not reached via a tappable row with
    // its own art) - the original captures document.getElementById(
    // "cover").src at call time instead, so this reads the same "what's
    // currently playing" cover from the shared repository instead.
    private val fallbackCover: String = when (target) {
        is BrowseTarget.Artist -> target.cover
        is BrowseTarget.Album -> target.cover
        is BrowseTarget.Playlist -> target.cover
        BrowseTarget.CurrentAlbum, is BrowseTarget.CurrentArtist ->
            playbackStateRepository.state.value?.cover ?: ""
        else -> ""
    }

    private fun List<BrowseItem>.withFallbackCovers(): List<BrowseItem> =
        if (fallbackCover.isEmpty()) this
        else map { if (it.cover.isEmpty()) it.copy(cover = fallbackCover) else it }

    private val _uiState = MutableStateFlow(BrowseUiState(locationLabel = initialLabel(target)))
    val uiState: StateFlow<BrowseUiState> = _uiState.asStateFlow()

    private var hasLoadedOnce = false

    // only meaningful for Library: /library-more's full scan result,
    // restored on a re-sync instead of showing /library-back's partial
    // viewport-only scrape - same reasoning as the web client's
    // libraryFullCache
    private var libraryFullScan: List<BrowseItem>? = null

    init {
        load()
    }

    // called from BrowseScreen's ON_RESUME lifecycle observer - fires
    // both on first composition (redundant with init{}'s own load(),
    // harmless) and every time this screen is returned to via back
    fun onResumed() {
        if (hasLoadedOnce) load()
    }

    fun onItemClick(item: BrowseItem, onNavigate: (BrowseTarget) -> Unit, onPlayed: () -> Unit) {
        when (item.type) {
            "artist" -> onNavigate(BrowseTarget.Artist(item.id, item.title, item.cover))
            "album" -> onNavigate(BrowseTarget.Album(item.id, item.title, item.cover))
            "playlist" -> onNavigate(BrowseTarget.Playlist(item.id, item.title, item.cover))
            "folder" -> onNavigate(BrowseTarget.LibraryFolder(item.id, item.title))
            else -> playItem(item.id, onPlayed)
        }
    }

    // matches the web client's playResult() exactly - it plays, then
    // closes the search overlay back to the player view (closeSearch())
    // rather than leaving the user sitting in the list they just tapped
    // out of. onPlayed() fires regardless of success/failure - a failed
    // play attempt is rare and returning to Now Playing either way is a
    // reasonable outcome, not worth a separate error path here.
    private fun playItem(id: String, onPlayed: () -> Unit) {
        audioBufferingTrigger.notifyTrackChangeRequested()
        viewModelScope.launch {
            runCatching { apiService.playResult(id) }
            onPlayed()
        }
    }

    // matches performQueueAdd() - the return value drives the row's own
    // flash animation; queuedWhileOverlayOpen's half (a successful add
    // doesn't change the playing title, so nothing else would prompt
    // NowPlayingViewModel to re-read the queue panel on its own) is
    // QueueRefreshTrigger instead, the two ViewModels' only shared link
    suspend fun addToQueue(id: String): Boolean {
        val ok = runCatching { apiService.queueAdd(id) }.getOrNull()?.isSuccessful == true
        if (ok) queueRefreshTrigger.requestRefresh()
        return ok
    }

    fun loadMore() {
        val current = target
        if (current !is BrowseTarget.Playlist && current !is BrowseTarget.Library) return
        if (_uiState.value.isLoadingMore) return

        _uiState.update { it.copy(isLoadingMore = true) }

        viewModelScope.launch {
            loadingIndicator.track {
                runCatching {
                    when (current) {
                        is BrowseTarget.Playlist -> {
                            val chunk = ndjsonClient.stream<PlaylistMoreChunk>("playlist-more").lastChunk()
                            setPaginated(chunk.tracks.withFallbackCovers(), canLoadMore = false)
                        }
                        is BrowseTarget.Library -> {
                            val chunk = ndjsonClient.stream<LibraryMoreChunk>(
                                "library-more",
                                mapOf("type" to current.libType)
                            ).lastChunk()
                            libraryFullScan = chunk.tracks
                            setPaginated(chunk.tracks, canLoadMore = false)
                        }
                        else -> Unit
                    }
                }.onFailure {
                    _uiState.update { it.copy(isLoadingMore = false) }
                }
            }
        }
    }

    fun onHomeSectionToggle(index: Int) {

        val alreadyLoaded = _uiState.value.sections.find { it.index == index }?.items != null

        _uiState.update { state ->
            state.copy(sections = state.sections.map {
                if (it.index == index) it.copy(expanded = !it.expanded) else it
            })
        }

        val nowExpanded = _uiState.value.sections.find { it.index == index }?.expanded == true
        if (!nowExpanded || alreadyLoaded) return

        viewModelScope.launch {
            loadingIndicator.track {
                runCatching { apiService.homeSection(index) }
                    .onSuccess { items ->
                        _uiState.update { state ->
                            state.copy(sections = state.sections.map {
                                if (it.index == index) it.copy(items = items) else it
                            })
                        }
                    }
            }
        }

    }

    private fun load() {
        viewModelScope.launch {

            _uiState.update { it.copy(isLoading = true, error = null) }

            // Artist/CurrentArtist end this early (on the first NDJSON
            // chunk, not the whole stream) - see the guarded end below -
            // so begin()/end() are called directly here instead of via
            // the track() helper, which would only ever end after the
            // full suspend block returns.
            loadingIndicator.begin()
            var loadingEnded = false
            fun endLoadingOnce() {
                if (!loadingEnded) {
                    loadingEnded = true
                    loadingIndicator.end()
                }
            }

            try {
                runCatching {
                    when (val current = target) {

                        BrowseTarget.Home -> setSections(apiService.home())
                        BrowseTarget.WhatsNew -> setFlatItems(apiService.whatsNew())

                        // matches browseArtist/browseCurrentArtist's own
                        // "shown" flag exactly - the original stops the
                        // header's fake-loading animation as soon as the
                        // first chunk of the discography stream arrives
                        // (results are already visible by then), rather
                        // than waiting for every remaining chunk through
                        // to the stream's end
                        is BrowseTarget.Artist ->
                            collectDiscography(ndjsonClient.stream("artist", mapOf("id" to current.id)), ::endLoadingOnce)
                        is BrowseTarget.CurrentArtist ->
                            collectDiscography(ndjsonClient.stream("current-artist"), ::endLoadingOnce)

                        is BrowseTarget.Album -> setFlatItems(apiService.album(current.id).withFallbackCovers())
                        BrowseTarget.CurrentAlbum -> {
                            val name = runCatching { apiService.currentAlbumName().name }.getOrDefault("")
                            _uiState.update { it.copy(locationLabel = name) }
                            setFlatItems(apiService.currentAlbum().withFallbackCovers())
                        }

                        is BrowseTarget.Playlist -> {
                            val data = apiService.playlist(current.id)
                            setPaginated(data.tracks.withFallbackCovers(), canLoadMore = !data.atBottom)
                        }

                        is BrowseTarget.Library -> {
                            if (!hasLoadedOnce) {
                                libraryFullScan = null
                                val data = apiService.library(current.libType)
                                setPaginated(data.tracks, canLoadMore = !data.atBottom)
                            } else {
                                val resynced = apiService.libraryBack(exitFolder = 1)
                                libraryFullScan?.let { setPaginated(it, canLoadMore = false) }
                                    ?: setPaginated(resynced, canLoadMore = _uiState.value.canLoadMore)
                            }
                        }

                        is BrowseTarget.LibraryFolder -> {
                            val results = if (!hasLoadedOnce) {
                                apiService.libraryFolder(current.id)
                            } else {
                                apiService.libraryBack(exitFolder = null)
                            }
                            setFlatItems(results)
                        }

                    }
                    hasLoadedOnce = true
                }.onFailure {
                    _uiState.update { it.copy(isLoading = false, error = "Erreur") }
                }
            } finally {
                endLoadingOnce()
            }

        }
    }

    private suspend fun collectDiscography(flow: Flow<DiscographyChunk>, onFirstChunk: () -> Unit) {
        var first = true
        flow.collect { chunk ->
            if (first) {
                first = false
                onFirstChunk()
            }
            _uiState.update {
                it.copy(
                    isLoading = false,
                    items = chunk.albums.withFallbackCovers(),
                    singles = chunk.singles.withFallbackCovers(),
                    compilations = chunk.compilations.withFallbackCovers()
                )
            }
        }
    }

    private fun setFlatItems(items: List<BrowseItem>) {
        _uiState.update {
            it.copy(
                isLoading = false,
                items = items,
                singles = emptyList(),
                compilations = emptyList(),
                sections = emptyList(),
                canLoadMore = false
            )
        }
    }

    private fun setPaginated(items: List<BrowseItem>, canLoadMore: Boolean) {
        _uiState.update {
            it.copy(isLoading = false, isLoadingMore = false, items = items, canLoadMore = canLoadMore)
        }
    }

    private fun setSections(sections: List<com.jbarnaud.spotifyremote.network.dto.HomeSectionDto>) {
        _uiState.update {
            it.copy(isLoading = false, sections = sections.mapIndexed { i, s -> HomeSectionUi(i, s.heading) })
        }
    }

}

private suspend fun <T> Flow<T>.lastChunk(): T {
    var last: T? = null
    collect { last = it }
    return last ?: error("empty NDJSON stream")
}

private fun initialLabel(target: BrowseTarget): String = when (target) {
    BrowseTarget.Home -> "Accueil"
    BrowseTarget.WhatsNew -> "Nouveautés"
    is BrowseTarget.Artist -> target.title
    is BrowseTarget.CurrentArtist -> target.title
    is BrowseTarget.Album -> target.title
    BrowseTarget.CurrentAlbum -> ""
    is BrowseTarget.Playlist -> target.title
    is BrowseTarget.Library -> libraryTypeLabels[target.libType] ?: target.libType
    is BrowseTarget.LibraryFolder -> target.title
}
