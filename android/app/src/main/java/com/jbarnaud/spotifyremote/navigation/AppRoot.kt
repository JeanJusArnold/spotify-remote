package com.jbarnaud.spotifyremote.navigation

import android.Manifest
import android.content.Intent
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import androidx.navigation.compose.rememberNavController
import com.jbarnaud.spotifyremote.AppViewModel
import com.jbarnaud.spotifyremote.feature.browse.BrowseScreen
import com.jbarnaud.spotifyremote.feature.browse.BrowseTarget
import com.jbarnaud.spotifyremote.feature.nowplaying.NowPlayingScreen
import com.jbarnaud.spotifyremote.feature.search.SearchBar
import com.jbarnaud.spotifyremote.feature.search.SearchResultsScreen
import com.jbarnaud.spotifyremote.feature.search.SearchViewModel
import com.jbarnaud.spotifyremote.feature.settings.SettingsScreen
import com.jbarnaud.spotifyremote.player.PlaybackService
import com.jbarnaud.spotifyremote.ui.components.SpotifyRemoteHeader
import com.jbarnaud.spotifyremote.ui.theme.SpotifyColors

// Gates on whether a server address has ever been saved, independent of
// any NavHost destination - a fresh install has no address configured
// yet, and the app is meant to be shareable (not hardcoded to one
// person's server), so this has to be a real first-run prompt rather
// than a baked-in constant. isLoaded distinguishes "haven't read
// DataStore yet" from "read it, nothing saved" to avoid a one-frame
// flash of the settings screen even when an address was already saved.
@Composable
fun AppRoot() {

    val appViewModel: AppViewModel = hiltViewModel()
    val baseUrl by appViewModel.currentBaseUrl.collectAsState()
    val isLoaded by appViewModel.isLoaded.collectAsState()
    val context = LocalContext.current

    // POST_NOTIFICATIONS (API 33+) is what makes the foreground
    // service's notification actually visible - request it once up
    // front rather than waiting for the service to need it. A no-op on
    // older API levels (the permission doesn't exist there).
    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* denial just means the notification stays invisible - the
           foreground service itself still runs either way */ }

    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // starts once a server address exists, independent of which screen
    // is showing - playback should keep syncing even while browsing
    // away from NowPlayingScreen. startForegroundService (not
    // startService) is required since the Service must call
    // startForeground() within seconds of being created - see its own
    // comment for why this needs to be a real foreground service at all.
    LaunchedEffect(baseUrl) {
        if (baseUrl != null) {
            ContextCompat.startForegroundService(context, Intent(context, PlaybackService::class.java))
        }
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        when {
            !isLoaded -> Box(modifier = Modifier.fillMaxSize())
            baseUrl == null -> SettingsScreen()
            else -> {
                val navController = rememberNavController()

                // shared, not hiltViewModel()'s default per-destination
                // scoping - the same query/ghost/results state needs to
                // survive both while typing on the persistent SearchBar
                // (see below) and while looking at the results screen it
                // navigates to, matching the original's single
                // #searchInput/#searchResults DOM element pair rather
                // than two independent copies
                val searchViewModel: SearchViewModel = hiltViewModel()

                fun navigateToBrowse(target: BrowseTarget) {
                    navController.navigate(Destinations.Browse.routeFor(target))
                }

                // resolved shared/tapped Spotify links (see MainActivity
                // + AppViewModel.resolveSharedLink) - collected here, not
                // inside AppViewModel itself, since acting on them needs
                // navController/Snackbar, both Compose-scoped. Both are
                // one-shot SharedFlows (see AppViewModel's own comment),
                // so a plain collect is correct - no risk of replaying a
                // stale navigation on recomposition the way a StateFlow
                // would.
                val snackbarHostState = remember { SnackbarHostState() }
                LaunchedEffect(Unit) {
                    appViewModel.navigationTarget.collect { target -> navigateToBrowse(target) }
                }
                LaunchedEffect(Unit) {
                    appViewModel.snackbarMessage.collect { message -> snackbarHostState.showSnackbar(message) }
                }

                // Settings is a native-only necessity with no original
                // equivalent at all - not a real NavHost destination, a
                // plain boolean-driven overlay that paints over
                // everything else (header, search bar, whatever browse
                // screen is underneath), the same way the original's own
                // #searchOverlay covers .now-playing. Keeping it OUT of
                // the nav back stack is deliberate, not just simpler:
                // going through navController would stop/resume whatever
                // Browse screen was underneath, and BrowseViewModel's
                // onResumed() always re-syncs against the server on
                // every resume (see its own comment) - correct when
                // you've actually navigated the real Spotify page deeper
                // and come back, completely wasted when you've only
                // dipped into Settings, which never touches that page at
                // all.
                var showSettings by remember { mutableStateOf(false) }
                BackHandler(enabled = showSettings) { showSettings = false }

                // matches the web client's playResult() closing the
                // search overlay back to the player view - pops every
                // Search/Browse entry back down to the already-alive
                // NowPlaying instance at the bottom of the stack rather
                // than pushing a new one
                fun returnToNowPlaying() {
                    navController.popBackStack(Destinations.NowPlaying.route, inclusive = false)
                }

                // a resolved track link (see AppViewModel.returnToNowPlaying's
                // own comment) needs this same pop-to-NowPlaying, not just
                // the Snackbar - otherwise it plays silently behind
                // whatever Search/Browse screen the user was already on
                LaunchedEffect(Unit) {
                    appViewModel.returnToNowPlaying.collect { returnToNowPlaying() }
                }

                // matches beginAbortableLoad/endAbortableLoad exactly -
                // AppViewModel.isBrowseLoading is driven by every real
                // browse/search network call (LoadingIndicatorController,
                // wired into BrowseViewModel.load()/loadMore()/
                // onHomeSectionToggle() and SearchViewModel's real
                // search), not a fixed timer guessing how long a request
                // takes
                val homeLoading by appViewModel.isBrowseLoading.collectAsState()

                // Box, not just the Column directly - Settings paints in
                // as a later sibling below, so it stacks visually above
                // every other child here (header, search bar, NavHost)
                // instead of only covering the NavHost's own area.
                Box(modifier = Modifier.fillMaxSize()) {

                    // Like the original's single topbar sitting outside
                    // #searchOverlay, this header lives above the NavHost
                    // instead of inside NowPlayingScreen, so it stays on
                    // screen across every real destination (Search,
                    // Browse) rather than disappearing the moment you
                    // navigate away from Now Playing. safeDrawing's top
                    // inset is claimed once here (so the header itself
                    // clears the status bar) and then marked consumed for
                    // the NavHost below, so each screen's own
                    // windowInsetsPadding(WindowInsets.safeDrawing) call
                    // doesn't double up on that same top padding a second
                    // time.
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top))
                    ) {

                        Box(modifier = Modifier.fillMaxWidth()) {

                            SpotifyRemoteHeader(
                                isLoading = homeLoading,
                                onClick = { navigateToBrowse(BrowseTarget.Home) }
                            )

                            // the original has no Settings equivalent at all -
                            // this is a native-only necessity, kept small and
                            // out of the way of the keycap branding rather than
                            // given the same visual weight. Search used to have
                            // an icon here too, but the original never hides
                            // search behind one - it's the always-visible bar
                            // below the header now (see SearchBar further down).
                            // BottomEnd (not TopEnd) so it sits in the header's
                            // bottom-right corner regardless of whether the
                            // keycaps wrap to one or two lines. bottom and end
                            // equal so the gap to the header's bottom edge
                            // matches the gap to the screen's right edge -
                            // IconButton's own internal padding is symmetric
                            // around the glyph, so it adds the same constant to
                            // both and doesn't break this equality.
                            Row(
                                modifier = Modifier
                                    .align(Alignment.BottomEnd)
                                    .padding(bottom = 8.dp, end = 8.dp)
                            ) {
                                IconButton(onClick = { showSettings = true }) {
                                    Icon(
                                        Icons.Filled.Settings,
                                        contentDescription = "Réglages",
                                        tint = SpotifyColors.TextSecondary
                                    )
                                }
                            }

                        }

                        // public/index.html: .search is a sibling of
                        // #searchOverlay, not nested inside it - and
                        // .search { z-index:2 } sits ABOVE #searchOverlay's
                        // own z-index:1, so it stays visible over every
                        // "screen" state (browsing results, an open overlay,
                        // whatever), not just Now Playing. Living here next
                        // to the header (rather than inside NowPlayingScreen)
                        // is the direct Compose analog of that persistence.
                        SearchBar(
                            onNavigate = ::navigateToBrowse,
                            onNavigateResults = { navController.navigate(Destinations.Search.route) },
                            onClose = ::returnToNowPlaying,
                            viewModel = searchViewModel,
                            modifier = Modifier.padding(horizontal = 20.dp)
                        )

                        NavHost(
                            navController,
                            startDestination = Destinations.NowPlaying.route,
                            modifier = Modifier
                                .weight(1f)
                                .consumeWindowInsets(WindowInsets.safeDrawing.only(WindowInsetsSides.Top)),
                            // navigation-compose 2.8.0 defaults to a fade
                            // transition when none is specified (older
                            // versions were instant) - explicitly opt
                            // back into instant navigation
                            enterTransition = { EnterTransition.None },
                            exitTransition = { ExitTransition.None },
                            popEnterTransition = { EnterTransition.None },
                            popExitTransition = { ExitTransition.None }
                        ) {
                            composable(Destinations.NowPlaying.route) {
                                NowPlayingScreen(
                                    onOpenArtist = { artist -> navigateToBrowse(BrowseTarget.CurrentArtist(artist)) },
                                    onOpenAlbum = { navigateToBrowse(BrowseTarget.CurrentAlbum) },
                                    // writeAlbumNameToSearch()'s target -
                                    // the first tap on the cover previews
                                    // the album name in this same
                                    // persistent search bar without
                                    // navigating anywhere
                                    onAlbumNamePreview = searchViewModel::onQueryChange
                                )
                            }
                            composable(Destinations.Search.route) {
                                SearchResultsScreen(
                                    onNavigate = ::navigateToBrowse,
                                    onBack = { navController.popBackStack() },
                                    onPlayed = ::returnToNowPlaying,
                                    showBackButton = navController.previousBackStackEntry?.destination?.route != Destinations.NowPlaying.route,
                                    viewModel = searchViewModel
                                )
                            }
                            composable(
                                Destinations.Browse.route,
                                arguments = listOf(
                                    navArgument("kind") { type = NavType.StringType },
                                    navArgument("id") { type = NavType.StringType },
                                    navArgument("title") { type = NavType.StringType; defaultValue = "" },
                                    navArgument("cover") { type = NavType.StringType; defaultValue = "" }
                                )
                            ) {
                                BrowseScreen(
                                    onNavigate = ::navigateToBrowse,
                                    onBack = { navController.popBackStack() },
                                    onPlayed = ::returnToNowPlaying,
                                    showBackButton = navController.previousBackStackEntry?.destination?.route != Destinations.NowPlaying.route
                                )
                            }
                        }

                    }

                    if (showSettings) {
                        Box(modifier = Modifier.fillMaxSize()) {
                            SettingsScreen(onSaved = { showSettings = false })
                        }
                    }

                    SnackbarHost(
                        hostState = snackbarHostState,
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .windowInsetsPadding(WindowInsets.safeDrawing)
                    )

                }
            }
        }
    }

}
