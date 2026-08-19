package com.jbarnaud.spotifyremote.feature.browse

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.jbarnaud.spotifyremote.ui.theme.SpotifyColors

@Composable
fun BrowseScreen(
    onNavigate: (BrowseTarget) -> Unit,
    onBack: () -> Unit,
    onPlayed: () -> Unit,
    // matches overlayBackButton.classList.toggle("visible",
    // navigationStack.length > 0) - the original only shows the back
    // chevron once you've navigated at least one level deep within the
    // overlay; the very first view after opening it (nothing to return
    // to but closing the whole overlay) shows none. visibility:hidden
    // (not display:none) in the original reserves the button's own
    // layout space either way, so #overlayLocation's position doesn't
    // shift when it appears - alpha(0f) here does the same instead of
    // conditionally omitting the IconButton entirely.
    showBackButton: Boolean = true,
    viewModel: BrowseViewModel = hiltViewModel()
) {

    val uiState by viewModel.uiState.collectAsState()

    // fires on first composition (redundant with the ViewModel's own
    // init{} load, harmless) AND every time this exact screen instance
    // is returned to via back - see onResumed()'s own comment for why
    // that re-fetch is load-bearing, not just a freshness nicety
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) viewModel.onResumed()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // Navigation-Compose handles the system back gesture/button itself
    // by default (calling popBackStack() directly, bypassing onBack
    // entirely) - this intercepts it so it goes through the same
    // server-resync as the visible arrow below. See goBack's own
    // comment for why that resync matters.
    BackHandler(enabled = showBackButton) { viewModel.goBack(onBack) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SpotifyColors.Background)
            .windowInsetsPadding(WindowInsets.safeDrawing)
    ) {

        // #overlayHeader itself has no padding, but it sits inside
        // #searchOverlay { padding:20px } - the title isn't flush
        // against the screen edge, it keeps that same 20px inset every
        // other row on this screen uses. The back button, though, has
        // its own margin:-4px 0 -4px -8px pulling it back out toward
        // the edge - keeping the Row's own start padding small (4dp)
        // and adding the 20dp only on the end keeps the chevron close
        // to the edge while still giving the title its real gap.
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 4.dp, end = 20.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(
                onClick = { viewModel.goBack(onBack) },
                enabled = showBackButton,
                modifier = Modifier.alpha(if (showBackButton) 1f else 0f)
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Retour", tint = SpotifyColors.TextPrimary)
            }
            // #overlayLocation { text-align:right } inside
            // #overlayHeader { justify-content:space-between } - the
            // title sits at the row's right edge, not left-aligned next
            // to the back button
            Text(
                uiState.locationLabel,
                color = SpotifyColors.TextPrimary,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f)
            )
        }

        BrowseResultsList(
            state = uiState,
            onItemClick = { viewModel.onItemClick(it, onNavigate, onPlayed) },
            onHomeSectionToggle = viewModel::onHomeSectionToggle,
            onLoadMore = viewModel::loadMore,
            onAddToQueue = viewModel::addToQueue,
            modifier = Modifier.weight(1f)
        )

    }

}
