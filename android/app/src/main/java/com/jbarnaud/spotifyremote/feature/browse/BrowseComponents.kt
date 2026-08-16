package com.jbarnaud.spotifyremote.feature.browse

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.jbarnaud.spotifyremote.network.dto.BrowseItem
import com.jbarnaud.spotifyremote.ui.components.SwipeToConfirmRow
import com.jbarnaud.spotifyremote.ui.theme.SpotifyColors
import kotlinx.coroutines.launch

// artist/album/playlist/folder rows navigate on tap - "add to queue"
// only makes sense for the remaining case, an actual track. Matches
// BROWSABLE_TYPES in player.js exactly.
private val BrowsableTypes = setOf("artist", "album", "playlist", "folder")

// One row shape shared by every browse surface (search results, whats-
// new, discography, album/playlist/library tracks, folders, home shelf
// cards) - mirrors createResultItem in player.js. Uses SpotifyColors
// rather than MaterialTheme roles, same reasoning as NowPlayingScreen -
// see SpotifyColors' own comment.
//
// Swipe left-to-right on a track row (not a browsable one) to add it to
// the queue - see SwipeToConfirmRow's own comment for why this
// replaced the old long-press interaction (easy to trigger by accident
// while scrolling). The original's attachLongPress + showTrackActionSheet
// two-step press-then-confirm via a hand-positioned floating sheet was
// never ported at all - a Compose DropdownMenu/Popup port of that step
// proved unreliable on a real device (left touch input broken elsewhere
// on the screen after being dismissed via its own item, not reproducible
// through adb-driven synthetic touches to debug further).
@Composable
fun BrowseResultRow(item: BrowseItem, onClick: () -> Unit, onAddToQueue: suspend (String) -> Boolean) {

    val scope = rememberCoroutineScope()
    val queueable = item.type !in BrowsableTypes

    SwipeToConfirmRow(
        onClick = onClick,
        swipeEnabled = queueable,
        label = "Ajouter",
        onConfirm = { scope.launch { onAddToQueue(item.id) } },
        coverSize = 48.dp,
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)
    ) {
        AsyncImage(
            model = item.cover,
            contentDescription = null,
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(4.dp))
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                item.title,
                color = SpotifyColors.TextPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                item.subtitle,
                color = SpotifyColors.TextSecondary,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            item.meta?.let {
                Text(it, color = SpotifyColors.TextTertiary, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
fun CollapsibleSection(
    heading: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    content: @Composable () -> Unit
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggle)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(heading, color = SpotifyColors.TextPrimary, fontWeight = FontWeight.Bold)
            Icon(
                if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                contentDescription = null,
                tint = SpotifyColors.TextSecondary
            )
        }
        if (expanded) content()
    }
}

// Renders whatever shape a BrowseUiState currently holds: home's
// collapsible shelves, an artist's flat albums + collapsible singles/
// compilations, or a plain flat/paginated list - BrowseScreen and
// SearchScreen both drive this off the same state shape.
@Composable
fun BrowseResultsList(
    state: BrowseUiState,
    onItemClick: (BrowseItem) -> Unit,
    onHomeSectionToggle: (Int) -> Unit,
    onLoadMore: () -> Unit,
    onAddToQueue: suspend (String) -> Boolean,
    modifier: Modifier = Modifier
) {

    when {

        // The header's own fill/typing animation (SpotifyRemoteHeader,
        // driven by LoadingIndicatorController) is the original's ONLY
        // loading affordance - #searchResults itself shows nothing while
        // a fetch is in flight, not a spinner. An empty Box here, not a
        // CircularProgressIndicator, keeps this screen's content area
        // matching that exactly.
        state.isLoading -> Box(modifier.fillMaxSize())

        state.error != null -> Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(state.error, color = SpotifyColors.TextSecondary)
        }

        state.sections.isNotEmpty() -> LazyColumn(modifier = modifier.fillMaxSize()) {
            items(state.sections, key = { it.index }) { section ->
                CollapsibleSection(
                    heading = section.heading,
                    expanded = section.expanded,
                    onToggle = { onHomeSectionToggle(section.index) }
                ) {
                    Column {
                        when {
                            // loadHomeSection() also runs through
                            // beginAbortableLoad/endAbortableLoad in the
                            // original - same header-only feedback, no
                            // local spinner per section either
                            section.items == null -> Box(Modifier.fillMaxWidth().padding(24.dp))
                            section.items.isEmpty() -> Text(
                                "Aucun résultat",
                                color = SpotifyColors.TextSecondary,
                                modifier = Modifier.padding(16.dp)
                            )
                            // meta here is Spotify's own small per-item
                            // context caption ("Pour les fans de X",
                            // "Conçu spécialement pour vous"...) on the
                            // web player's "Suggestions Spotify" shelf -
                            // shown there ABOVE each card, not below like
                            // BrowseResultRow's own default meta styling
                            // (used elsewhere, e.g. Nouveautés' "Single ·
                            // il y a 17 heures") - so it's rendered here
                            // directly instead, and stripped via copy()
                            // before handing the item to BrowseResultRow
                            // so it isn't shown a second time underneath.
                            // A caption pairs with the ROW BELOW it, not
                            // the one above - the gap ahead of each
                            // caption (24dp explicit gap + the previous
                            // row's own 10dp bottom padding = 34dp) is
                            // deliberately much larger than the gap
                            // between a caption and its own row (2dp +
                            // the row's own 10dp top padding = 12dp), so
                            // that pairing reads unambiguously.
                            else -> section.items.forEachIndexed { index, item ->
                                if (index > 0) Spacer(Modifier.height(24.dp))
                                item.meta?.let {
                                    Text(
                                        it,
                                        color = SpotifyColors.TextSecondary,
                                        fontSize = 12.sp,
                                        modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 2.dp)
                                    )
                                }
                                BrowseResultRow(
                                    item.copy(meta = null),
                                    onClick = { onItemClick(item) },
                                    onAddToQueue = onAddToQueue
                                )
                            }
                        }
                    }
                }
            }
        }

        state.items.isEmpty() && state.singles.isEmpty() && state.compilations.isEmpty() ->
            Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Aucun résultat", color = SpotifyColors.TextSecondary)
            }

        else -> LazyColumn(modifier = modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {

            items(state.items, key = { it.id }) { item ->
                BrowseResultRow(item, onClick = { onItemClick(item) }, onAddToQueue = onAddToQueue)
            }

            if (state.singles.isNotEmpty()) {
                item {
                    var expanded by remember { mutableStateOf(false) }
                    CollapsibleSection("Singles", expanded, onToggle = { expanded = !expanded }) {
                        Column { state.singles.forEach { BrowseResultRow(it, onClick = { onItemClick(it) }, onAddToQueue = onAddToQueue) } }
                    }
                }
            }

            if (state.compilations.isNotEmpty()) {
                item {
                    var expanded by remember { mutableStateOf(false) }
                    CollapsibleSection("Compilations", expanded, onToggle = { expanded = !expanded }) {
                        Column { state.compilations.forEach { BrowseResultRow(it, onClick = { onItemClick(it) }, onAddToQueue = onAddToQueue) } }
                    }
                }
            }

            if (state.canLoadMore) {
                item {
                    // matches showLoadMoreButton()'s own click handler
                    // exactly - button.disabled = true, opacity:0.5 via
                    // .load-more-btn:disabled - not a spinner swap. The
                    // header fill is the original's only animated
                    // loading feedback; this button just dims in place.
                    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                        Button(
                            onClick = onLoadMore,
                            enabled = !state.isLoadingMore,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = SpotifyColors.Sheet,
                                contentColor = SpotifyColors.TextPrimary
                            )
                        ) { Text("Charger plus") }
                    }
                }
            }

        }

    }

}
