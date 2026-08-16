package com.jbarnaud.spotifyremote.feature.search

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import com.jbarnaud.spotifyremote.R
import com.jbarnaud.spotifyremote.feature.browse.BrowseResultsList
import com.jbarnaud.spotifyremote.feature.browse.BrowseTarget
import com.jbarnaud.spotifyremote.ui.theme.SpotifyColors

// includeFontPadding=false is load-bearing: without it, Android's
// default font metrics reserve extra descent space below the glyph
// baseline that isn't matched by an equal amount above it, so text sits
// visibly closer to the top of its own padded box, leaving a bigger gap
// underneath. Shared by both the ghost layer's Text()s and the real
// BasicTextField so their glyph vertical position lines up exactly.
private val SearchFieldTextStyle = TextStyle(
    fontSize = 16.sp,
    platformStyle = PlatformTextStyle(includeFontPadding = false)
)

// Ported from the original's actual search bar (public/index.html
// .search / #searchGhost / #searchInput, public/js/player.js's
// updateSearchGhost/doSearch) - NOT a menu opened from an icon. In the
// original this bar sits directly in the page, right below the topbar,
// permanently visible alongside the now-playing content - so this is
// embedded straight into NowPlayingScreen rather than living behind its
// own destination. Typing "p"/"ar"/"al" (French library-shortcut
// abbreviations, author-specific - see SearchViewModel) or "n"
// ("Nouveautés") and submitting routes straight into library/what's-new
// browsing instead of running a real search, with an inline gray
// "ghost" completion previewing the matched shortcut's full label as
// you type it. Only a real query (not a shortcut) needs somewhere to
// show results - onNavigateResults handles that, matching the
// original's #searchOverlay taking over for actual search results
// while shortcuts never open it at all.
@Composable
fun SearchBar(
    onNavigate: (BrowseTarget) -> Unit,
    onNavigateResults: () -> Unit,
    onClose: () -> Unit,
    viewModel: SearchViewModel,
    modifier: Modifier = Modifier
) {

    // These two icons (Effacer/X, Rechercher/magnifier) sit directly on
    // whatever's behind the bar rather than on their own opaque pill
    // (unlike the rest of the app, which paints a full-bleed dark
    // background per screen) - with the system in light mode, that
    // background is light, and a hardcoded-white icon there goes
    // invisible. Following the system theme here, same as the rest of
    // Android would, instead of forcing this bar to stay dark
    // regardless.
    val iconTint = if (isSystemInDarkTheme()) SpotifyColors.TextPrimary else Color.Black

    // No extra horizontal padding here by default - AppRoot supplies
    // 20dp via its own modifier, same as every other row on this screen.
    // An earlier version added another 12dp on top of that just for this
    // Row, which made the edge-to-icon gap (32dp) far bigger than the
    // icon-to-pill gap (the old 8dp spacedBy) - fixed below by sharing
    // one spacedBy value equal to that same 20dp instead.
    // top=19dp: header-to-bar gap, deliberately shrunk by a third from
    // the 28dp it briefly matched bar-to-cover at (28 * 2/3 ≈ 19) - only
    // this side, not the bar-to-cover gap below (see bottom=8dp, back to
    // its original value; NowPlayingScreen's cover Row is back to
    // top=20dp too), so the two are no longer symmetric on purpose.
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 19.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {

        // matches #searchCloseButton / closeSearch() exactly - clearing
        // the value is only half of it. closeSearch() also calls
        // hideSearchOverlay(), returning to .now-playing underneath -
        // now that this bar is hoisted up to AppRoot and persists over
        // every screen (not just NowPlayingScreen, where "close" used to
        // have nothing to close), that's onClose() popping the nav stack
        // back to NowPlaying. Sized down from IconButton's default 48dp
        // touch target to 36dp - the default's hidden internal padding
        // was the other source of the edge/pill imbalance (it doesn't
        // show up as a gap either spacedBy value above controls), and
        // shrinking it also gives the pill back some of the width it was
        // losing to that padding.
        //
        // closeSearch() in the original doesn't just clear the value -
        // it also calls searchInputEl.blur(). Without the matching
        // clearFocus() here, the field stayed focused (keyboard still
        // up) after tapping X, so it never actually felt like leaving
        // search even though the text was gone.
        val focusManager = LocalFocusManager.current
        IconButton(
            onClick = {
                viewModel.onClear()
                focusManager.clearFocus()
                onClose()
            },
            modifier = Modifier.size(36.dp)
        ) {
            Icon(
                Icons.Filled.Close,
                contentDescription = "Effacer",
                tint = iconTint,
                modifier = Modifier.size(21.dp)
            )
        }

        // height(IntrinsicSize.Max) below is load-bearing: BasicTextField
        // and a plain Text() compute slightly different heights for the
        // same fontSize (different internal line-height metrics), so
        // without forcing both children to share one height, the taller
        // of the two pokes its rounded background out past the shorter
        // one's edge - visible as the ghost layer's #222 fill spilling
        // out past the input's own border, worst at the bottom since
        // Box top-aligns both by default.
        Box(modifier = Modifier.weight(1f).height(IntrinsicSize.Max)) {

            val shownQuery = viewModel.query
            val ghost = viewModel.ghostSuggestion

            // #searchGhost: sits behind the real input, same padding/
            // radius/font so the two stay perfectly aligned. The typed
            // part is rendered transparent (ghost-typed is
            // visibility:hidden in the original) purely to reserve the
            // same horizontal space so ghostSuggestion starts exactly
            // where the real caret ends up. #222 background, matching
            // the original exactly (SpotifyColors.Divider, not Sheet).
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(20.dp))
                    .background(SpotifyColors.Divider)
                    .padding(start = 16.dp, end = 36.dp, top = 10.dp, bottom = 10.dp)
            ) {
                Text(shownQuery, style = SearchFieldTextStyle.copy(color = Color.Transparent), maxLines = 1)
                Text(ghost, style = SearchFieldTextStyle.copy(color = SpotifyColors.TextTertiary), maxLines = 1)
            }

            // #searchInput has no authored focus style - border:1px
            // solid #333 is its only rule - so the original's white
            // focus outline the user is describing is the browser's own
            // native default focus ring, not something style.css draws.
            // BasicTextField has no such built-in ring, so this tracks
            // focus explicitly and swaps the border to white to match
            // what that native ring actually looked like.
            val interactionSource = remember { MutableInteractionSource() }
            val isFocused by interactionSource.collectIsFocusedAsState()

            BasicTextField(
                value = shownQuery,
                onValueChange = viewModel::onQueryChange,
                interactionSource = interactionSource,
                modifier = Modifier
                    .fillMaxWidth()
                    .fillMaxHeight()
                    .border(
                        1.dp,
                        if (isFocused) SpotifyColors.TextPrimary else SpotifyColors.SearchBorder,
                        RoundedCornerShape(20.dp)
                    )
                    .padding(start = 16.dp, end = 36.dp, top = 10.dp, bottom = 10.dp),
                singleLine = true,
                textStyle = SearchFieldTextStyle.copy(color = SpotifyColors.TextPrimary),
                cursorBrush = SolidColor(SpotifyColors.TextPrimary),
                // input[type=search] has no explicit autocapitalize
                // attribute, so mobile browsers fall back to their
                // default of "sentences" - capitalizing the first letter
                // as you start typing. Sentences (not Words) matches
                // that default exactly.
                keyboardOptions = KeyboardOptions(
                    imeAction = ImeAction.Search,
                    capitalization = KeyboardCapitalization.Sentences
                ),
                // doSearch() in the original calls searchInputEl.blur()
                // unconditionally, right at its own start, before even
                // checking for a shortcut match - every submission blurs
                // the input, not just ones that end up doing a real
                // search. Without the matching clearFocus() here, the
                // field stayed focused after navigating away (a shortcut
                // match, or tapping the search icon), even once its
                // keyboard/screen was gone.
                keyboardActions = KeyboardActions(onSearch = {
                    viewModel.onSearch(onNavigate, onNavigateResults)
                    focusManager.clearFocus()
                }),
                decorationBox = { innerTextField ->
                    // input[placeholder="Recherche"] in the original -
                    // BasicTextField has no built-in placeholder, so this
                    // draws it manually behind the real field, only while
                    // empty. Boxed so the placeholder sits underneath
                    // instead of stacking above it.
                    Box {
                        if (shownQuery.isEmpty()) {
                            Text("Recherche", style = SearchFieldTextStyle.copy(color = SpotifyColors.TextTertiary))
                        }
                        innerTextField()
                    }
                }
            )

            // input[type=search]'s native webkit-search-cancel-button -
            // a browser affordance, not anything style.css draws, sitting
            // inside the field itself and only clearing the typed text
            // (unlike #searchCloseButton/the outer "Effacer" icon, which
            // also blurs/exits search entirely). Per a screenshot of the
            // real rendering, it's a bare bold blue X - no circle behind
            // it - so Close (not Cancel), sized up from Chrome's own tiny
            // rendering per request.
            if (shownQuery.isNotEmpty()) {
                IconButton(
                    onClick = viewModel::onClear,
                    modifier = Modifier
                        .align(Alignment.CenterEnd)
                        .padding(end = 8.dp)
                        .size(28.dp)
                ) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = "Effacer le texte",
                        tint = Color(0xFF5C85D6),
                        modifier = Modifier.size(20.dp)
                    )
                }
            }

        }

        // matches #searchButton - same 36dp sizing as the clear button.
        // Ported icon (ic_search, 20dp to match the original's own
        // width="20" height="20"), not Material's filled magnifier -
        // the original's is a thin stroke-based glyph, not a solid fill.
        IconButton(
            onClick = {
                viewModel.onSearch(onNavigate, onNavigateResults)
                focusManager.clearFocus()
            },
            modifier = Modifier.size(36.dp)
        ) {
            Icon(
                painterResource(R.drawable.ic_search),
                contentDescription = "Rechercher",
                tint = iconTint,
                modifier = Modifier.size(20.dp)
            )
        }

    }

}

// The original's #searchOverlay as it appears for real search results
// specifically - just a back button + the results list, since the
// input bar itself lives on NowPlayingScreen (above) rather than being
// duplicated in here.
@Composable
fun SearchResultsScreen(
    onNavigate: (BrowseTarget) -> Unit,
    onBack: () -> Unit,
    onPlayed: () -> Unit,
    // see BrowseScreen's own showBackButton for the full explanation -
    // matches overlayBackButton.classList.toggle("visible",
    // navigationStack.length > 0)
    showBackButton: Boolean = true,
    viewModel: SearchViewModel
) {

    val uiState by viewModel.uiState.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SpotifyColors.Background)
            .windowInsetsPadding(WindowInsets.safeDrawing)
    ) {

        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(
                onClick = onBack,
                enabled = showBackButton,
                modifier = Modifier.alpha(if (showBackButton) 1f else 0f)
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Retour", tint = SpotifyColors.TextPrimary)
            }
        }

        BrowseResultsList(
            state = uiState,
            onItemClick = { viewModel.onItemClick(it, onNavigate, onPlayed) },
            onHomeSectionToggle = {},
            onLoadMore = {},
            onAddToQueue = viewModel::addToQueue,
            modifier = Modifier.fillMaxSize().padding(top = 8.dp)
        )

    }

}
