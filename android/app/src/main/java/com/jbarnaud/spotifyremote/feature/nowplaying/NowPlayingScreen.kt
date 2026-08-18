package com.jbarnaud.spotifyremote.feature.nowplaying

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import coil.compose.AsyncImage
import com.jbarnaud.spotifyremote.R
import com.jbarnaud.spotifyremote.network.dto.QueueItemDto
import com.jbarnaud.spotifyremote.ui.components.SwipeToConfirmRow
import com.jbarnaud.spotifyremote.ui.theme.SpotifyColors
import kotlin.math.cos
import kotlin.math.sin

// Deliberately not Scaffold/TopAppBar/default Slider - the original web
// client (public/index.html + style.css) is a hand-tuned, non-Material
// look (solid circular play button, thin-line seekbar, compact row
// layout that leaves room for the queue lists below it) and this screen
// is meant to read as the same app, not a generic Android template
// wrapped around the same data.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NowPlayingScreen(
    onOpenArtist: (String) -> Unit = {},
    onOpenAlbum: () -> Unit = {},
    onAlbumNamePreview: (String) -> Unit = {},
    viewModel: NowPlayingViewModel = hiltViewModel()
) {

    val uiState by viewModel.uiState.collectAsState()
    val queueState by viewModel.queueState.collectAsState()

    // Polling lives in PlaybackService now, unconditionally - see its
    // own comment. Nothing to start/stop here anymore based on this
    // screen's own visibility.

    // matches playResult()/closeSearch() resetting
    // coverTappedForCurrentAlbum on returning to the player view - Unit
    // never changes within one composition lifetime, so this only
    // reruns when this screen (re)enters composition: first launch, and
    // every time Search/Browse is popped back down to it - see
    // onScreenEntered's own comment
    LaunchedEffect(Unit) { viewModel.onScreenEntered() }

    // .container itself never scrolls in the original - body/.content/
    // .container are a chain of height-bounded flex columns
    // (height:100vh/100dvh down to min-height:0 on each), and only
    // #queueList/#manualQueueList themselves get overflow-y:auto, each
    // independently scrollable within whatever share of the remaining
    // space flex:1 gives them. The cover/time/seekbar/controls above
    // that never scroll out of view. Matched below by NOT scrolling this
    // outer Column at all, and giving the queue area its own
    // Modifier.weight(1f) region containing one or two LazyColumns
    // (their own scroll standing in for overflow-y:auto), splitting that
    // region evenly when both queue sections are present - the same
    // even split flex:1 on both gives them in the original.
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SpotifyColors.Background)
            .windowInsetsPadding(WindowInsets.safeDrawing)
    ) {

        Column(modifier = Modifier.padding(horizontal = 20.dp).fillMaxHeight()) {

        // Covers cover/title/artist/position/seekbar/controls together
        // with a single "BUFFER" overlay after next/previous/playing a
        // specific track (AudioBufferingTrigger, collected in
        // NowPlayingViewModel) - unrelated to playPauseShielded below,
        // which only protects the play/pause button itself, mirroring
        // the server's real mprisBlocked state during a narrow danger
        // window. This is about a different, always-present gap: the
        // command lands on
        // Spotify almost immediately, but the audio actually reaches this
        // phone's ear ~HLS_SEGMENT_SECONDS behind the live edge, so
        // there's always a real wait between "the app shows the new
        // track" and "you can hear it" - this overlay is what explains
        // that wait instead of leaving the screen looking like nothing
        // happened.
        Box(modifier = Modifier.fillMaxWidth()) {

        Column {

        // public/index.html: .search sits directly below .topbar, above
        // .now-playing - now hoisted up to AppRoot, next to the header,
        // since the original keeps it visible above every screen
        // (z-index:2 over #searchOverlay's z-index:1), not just here.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 20.dp, bottom = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(15.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {

            AsyncImage(
                model = uiState.cover,
                contentDescription = null,
                modifier = Modifier
                    .size(100.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .clickable {
                        viewModel.onCoverTap(onPreview = onAlbumNamePreview, onNavigateToAlbum = onOpenAlbum)
                    }
            )

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = uiState.title,
                    color = SpotifyColors.TextPrimary,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    modifier = Modifier
                        .fillMaxWidth()
                        .basicMarquee()
                )
                Text(
                    text = uiState.artist,
                    color = SpotifyColors.TextSecondary,
                    maxLines = 1,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 5.dp)
                        .basicMarquee()
                        .clickable(enabled = uiState.artist.isNotBlank()) { onOpenArtist(uiState.artist) }
                )
            }

        }

        Text(
            text = "${formatSeconds(uiState.positionSeconds)} / ${formatSeconds(uiState.durationSeconds)}",
            color = SpotifyColors.TextSecondary,
            fontSize = 14.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth()
        )

        Seekbar(
            positionSeconds = uiState.positionSeconds,
            durationSeconds = uiState.durationSeconds,
            onSeekFinished = viewModel::onSeek
        )

        // .controls itself carries no margin of its own - the gap to
        // whatever comes next is entirely .queue-heading's own
        // margin-top:30px below. This used to have its own bottom=24dp
        // as a stand-in "safe margin" back when nothing followed the
        // controls row at all; now that the queue sections are real
        // content, that padding was stacking on top of QueueHeading's
        // own 30dp top margin instead of just being it.
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically
        ) {

            IconButton(onClick = viewModel::onShuffleClick) {
                Icon(
                    painterResource(R.drawable.ic_shuffle),
                    contentDescription = "Aléatoire",
                    tint = if (uiState.shuffle) SpotifyColors.Green else SpotifyColors.TextPrimary,
                    modifier = Modifier.size(20.dp)
                )
            }

            IconButton(onClick = viewModel::onPrevious) {
                Icon(
                    Icons.Filled.SkipPrevious,
                    contentDescription = "Précédent",
                    tint = SpotifyColors.TextPrimary,
                    modifier = Modifier.size(42.dp)
                )
            }

            PlayPauseButton(
                playing = uiState.playing,
                shielded = uiState.playPauseShielded,
                onClick = viewModel::onPlayPauseClick
            )

            IconButton(onClick = viewModel::onNext) {
                Icon(
                    Icons.Filled.SkipNext,
                    contentDescription = "Suivant",
                    tint = SpotifyColors.TextPrimary,
                    modifier = Modifier.size(42.dp)
                )
            }

            Box {
                IconButton(onClick = viewModel::onRepeatClick) {
                    Icon(
                        painterResource(R.drawable.ic_repeat),
                        contentDescription = "Répéter",
                        tint = if (uiState.repeat != "off") SpotifyColors.Green else SpotifyColors.TextPrimary,
                        modifier = Modifier.size(20.dp)
                    )
                }
                // same icon tinted green for both repeat modes, plus this
                // small dot for "track" specifically - matches
                // #repeatDot exactly rather than swapping to a different
                // glyph shape the original never had
                if (uiState.repeat == "track") {
                    Box(
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(bottom = 6.dp)
                            .size(4.dp)
                            .clip(CircleShape)
                            .background(SpotifyColors.Green)
                    )
                }
            }

        }

        } // Column: cover/title/artist/position/seekbar/controls

        if (uiState.audioBuffering) {
            BufferOverlay(modifier = Modifier.matchParentSize())
        }

        } // Box

        // shared remaining-space region - see the outer Column's own
        // comment for how this maps flex:1 + overflow-y:auto. Not a
        // forced 50/50 split, though - #manualQueueSection itself is
        // flex-shrink:1 (default flex-grow:0), meaning it's sized by its
        // own CONTENT first (adding titles just grows it, pushing
        // #queueSection down/off screen) and only actually shrinks -
        // #manualQueueList's own overflow-y:auto kicking in - once its
        // natural content height would exceed all the space this shared
        // region has. BoxWithConstraints below reads that region's real
        // height so the manual list's own heightIn(max=...) can cap at
        // ALL of it (not a pre-divided half), matching that "grows
        // freely until there's truly no room left, then scrolls"
        // behavior - Modifier.weight(1f) alone can't express this since
        // weight always pre-allocates a fixed share up front.
        BoxWithConstraints(modifier = Modifier.weight(1f)) {
            val fullRegionHeight = with(LocalDensity.current) { constraints.maxHeight.toDp() }
            val manualQueueListState = rememberLazyListState()
            val queueListState = rememberLazyListState()

            // player.js's own updateState() forces manualQueueListEl/
            // queueListEl.scrollTop = 0 every time a new queue snapshot
            // actually replaces the rendered rows (it's skipped entirely
            // via lastQueueSignature when the fetched data is unchanged,
            // same as List equality skipping this LaunchedEffect here) -
            // otherwise removing a row or reordering would leave the
            // list scrolled to a now-meaningless position.
            LaunchedEffect(queueState.manualQueue) { manualQueueListState.scrollToItem(0) }
            LaunchedEffect(queueState.queue) { queueListState.scrollToItem(0) }

            Column(modifier = Modifier.fillMaxSize()) {

                // #manualQueueSection.visible - only shown once
                // something's actually been explicitly queued, matching
                // data.manualQueue.length > 0 in refreshContextAndQueue()
                if (queueState.manualQueue.isNotEmpty()) {
                    QueueHeading("À suivre dans la file d'attente")
                    Box(modifier = Modifier.heightIn(max = fullRegionHeight)) {
                        LazyColumn(state = manualQueueListState, modifier = Modifier.fillMaxWidth()) {
                            itemsIndexed(queueState.manualQueue) { index, item ->
                                QueueRow(
                                    item = item,
                                    onClick = { viewModel.onQueueItemClick(index, "manual", item) },
                                    onRemove = { viewModel.onQueueRemove(index, "manual") }
                                )
                            }
                        }
                        QueueScrollbarThumb(manualQueueListState)
                    }
                }

                // #queueSection has no .visible toggle in the original -
                // always present once a queue panel read has succeeded
                // at all, even if the algorithmic "up next" list itself
                // happens to be empty. weight(1f) here (unlike the
                // manual list above) matches #queueList's own flex:1 -
                // it's the one section that's SUPPOSED to always
                // immediately claim whatever's left, manual queue or not
                QueueHeading(
                    "À suivre",
                    context = queueState.context.takeIf { it.isNotEmpty() }?.let { "($it)" }
                )
                // pull-to-refresh here (not tied to isEmpty - the
                // standard gesture only ever engages once already
                // scrolled to the top anyway, so it's never in the way
                // of normal scrolling) doubles as the manual recovery
                // path for [[queue_external_webplayer_edits]] - one
                // /context-and-queue call refreshes both lists together,
                // so pulling here also catches a manual-queue add made
                // directly on the Web Player, not just this list.
                PullToRefreshBox(
                    isRefreshing = queueState.isRefreshing,
                    onRefresh = viewModel::refreshQueueManually,
                    modifier = Modifier.weight(1f)
                ) {
                    LazyColumn(state = queueListState, modifier = Modifier.fillMaxSize()) {
                        itemsIndexed(queueState.queue) { index, item ->
                            QueueRow(
                                item = item,
                                onClick = { viewModel.onQueueItemClick(index, "queue", item) },
                                onRemove = { viewModel.onQueueRemove(index, "queue") }
                            )
                        }
                    }
                    QueueScrollbarThumb(queueListState)
                }

            }
        }

        }

    }

}

// includeFontPadding=false is load-bearing, not cosmetic - same issue
// as SearchFieldTextStyle in SearchScreen.kt: Android's default font
// metrics reserve extra descent space below the glyph baseline that
// isn't part of style.css's own box model at all, so without this the
// heading's real visual gap to the padding.top=30dp/bottom=10dp CSS
// values reads noticeably bigger than 30px/10px actually are.
private val QueueHeadingTextStyle = TextStyle(
    fontSize = 13.sp,
    fontWeight = FontWeight.Bold,
    letterSpacing = 0.5.sp,
    platformStyle = PlatformTextStyle(includeFontPadding = false)
)

// .queue-heading { display:flex; gap:8px; margin-top:30px;
// margin-bottom:10px; text-transform:uppercase; letter-spacing:0.5px }.
// context is a genuinely separate span, not text glued onto the first
// one - #queueContext { flex:1; text-align:center; text-overflow:
// ellipsis; white-space:nowrap }, so it takes up the rest of the row's
// width and centers within THAT remaining space (which reads as
// roughly centered across the right two-thirds of the row, not tight
// against "À suivre"), and truncates with an ellipsis instead of
// wrapping if it's ever too long for that space.
@Composable
private fun QueueHeading(text: String, context: String? = null) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 30.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text.uppercase(),
            color = SpotifyColors.TextSecondary,
            style = QueueHeadingTextStyle,
            maxLines = 1
        )
        if (context != null) {
            Text(
                context,
                color = SpotifyColors.TextSecondary,
                style = QueueHeadingTextStyle,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f)
            )
        }
    }
}

// player.js's updateScrollThumb(): mobile Chrome's native overflow
// scrollbar only shows up while actively scrolling regardless of
// ::-webkit-scrollbar styling, so the original positions a real
// always-visible element from the list's own scroll metrics instead.
// Android's default scrollbar has the same "only visible while
// scrolling/flinging" behavior, so the same workaround applies here -
// LazyListState has no scrollHeight/clientHeight equivalent, but
// visibleItemsInfo + totalItemsCount let the same ratio math be
// rebuilt from an estimated average row height instead.
@Composable
private fun BoxScope.QueueScrollbarThumb(listState: LazyListState) {

    val density = LocalDensity.current

    val metrics by remember(listState) {
        derivedStateOf {
            val layoutInfo = listState.layoutInfo
            val items = layoutInfo.visibleItemsInfo
            val viewportHeight = layoutInfo.viewportSize.height
            if (items.isEmpty() || viewportHeight <= 0) return@derivedStateOf null

            val avgItemSize = items.sumOf { it.size }.toFloat() / items.size
            val estimatedTotalHeight = avgItemSize * layoutInfo.totalItemsCount
            val scrollableHeight = estimatedTotalHeight - viewportHeight
            // matches the original's scrollable <= 1 check - hides the
            // thumb entirely when everything already fits
            if (scrollableHeight <= 1f) return@derivedStateOf null

            val firstItem = items.first()
            val scrolledPast = (firstItem.index * avgItemSize - firstItem.offset)
                .coerceIn(0f, scrollableHeight)

            // sequential coerceAtLeast/coerceAtMost, not a single
            // coerceIn(min, max) - when the viewport itself is shorter
            // than the 30dp floor (a genuinely tiny list), min > max and
            // coerceIn throws; clamping in two steps just settles on
            // viewportHeight (a full-length thumb) in that edge case
            val minThumbPx = with(density) { 30.dp.toPx() }
            val thumbHeightPx = (viewportHeight.toFloat() * viewportHeight / estimatedTotalHeight)
                .coerceAtLeast(minThumbPx)
                .coerceAtMost(viewportHeight.toFloat())
            val maxOffsetPx = viewportHeight - thumbHeightPx
            val offsetPx = (maxOffsetPx * (scrolledPast / scrollableHeight)).coerceIn(0f, maxOffsetPx)

            thumbHeightPx to offsetPx
        }
    }

    val (thumbHeightPx, offsetPx) = metrics ?: return

    Box(
        Modifier
            .align(Alignment.TopEnd)
            .padding(end = 2.dp)
            .offset(y = with(density) { offsetPx.toDp() })
            .width(5.dp)
            .height(with(density) { thumbHeightPx.toDp() })
            .clip(RoundedCornerShape(3.dp))
            .background(Color.White.copy(alpha = 0.45f))
    )

}

// createQueueRow's own shape (reuses .result-item, same as every browse
// row) - tap plays it via queue-play, swipe left-to-right removes it
// (see SwipeToConfirmRow's own comment for why this replaced the old
// long-press interaction)
@Composable
private fun QueueRow(item: QueueItemDto, onClick: () -> Unit, onRemove: () -> Unit) {
    SwipeToConfirmRow(
        onClick = onClick,
        swipeEnabled = true,
        label = "Retirer",
        onConfirm = onRemove,
        coverSize = 45.dp,
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(vertical = 8.dp)
    ) {
        AsyncImage(
            model = item.cover,
            contentDescription = null,
            modifier = Modifier
                .size(45.dp)
                .clip(RoundedCornerShape(4.dp))
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                item.title,
                color = SpotifyColors.TextPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))
            )
            Text(
                item.subtitle,
                color = SpotifyColors.TextSecondary,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false)),
                modifier = Modifier.padding(top = 2.dp)
            )
        }
    }
}

// Solid white circle with a black glyph, not a Material tonal button -
// matches #play/.icon-play/.icon-pause exactly. Filling green while
// shielded IS the busy indicator (no separate disabled/greyed style),
// same as .play.shielded.
@Composable
private fun PlayPauseButton(
    playing: Boolean,
    shielded: Boolean,
    onClick: () -> Unit
) {
    Box(
        modifier = Modifier
            .size(64.dp)
            .clip(CircleShape)
            .background(SpotifyColors.TextPrimary)
            .clickable(enabled = !shielded, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        if (shielded) {
            // "do not touch" - a plain color fill read as an unrelated
            // color change (it used to be Spotify green); an explicit
            // prohibition glyph says directly why the tap won't do
            // anything right now, instead of just failing silently.
            Icon(
                Icons.Filled.Block,
                contentDescription = "Action en cours, patiente",
                tint = Color.Black,
                modifier = Modifier.size(34.dp)
            )
        } else if (playing) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(
                    Modifier
                        .width(5.dp)
                        .height(20.dp)
                        .background(Color.Black, RoundedCornerShape(1.dp))
                )
                Box(
                    Modifier
                        .width(5.dp)
                        .height(20.dp)
                        .background(Color.Black, RoundedCornerShape(1.dp))
                )
            }
        } else {
            Icon(
                Icons.Filled.PlayArrow,
                contentDescription = "Lecture",
                tint = Color.Black,
                modifier = Modifier.size(34.dp)
            )
        }
    }
}

// No background - the cover/title/seekbar/controls underneath stay
// visible, this just floats "BUFFER" on top of them. Only the text
// pulses, once every two seconds (1000ms fade out + 1000ms fade back in
// via RepeatMode.Reverse). Anchored at the zone's own bottom-right
// corner and tilted, banner-style, rather than sitting flat and
// centered.
//
// fittedFontSizeSp is solved so the ROTATED bounding box (not the flat
// text width) fits inside the zone's own maxWidth/maxHeight - a first
// version sized only against the (flat) screen width and let it spill
// upward past the zone into the search bar above, since nothing was
// containing the rotated overflow to the zone itself. clipToBounds()
// below is a safety net for any leftover rounding, not the primary fix.
@Composable
private fun BufferOverlay(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "buffer-pulse")
    val alpha by transition.animateFloat(
        initialValue = 0.3f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1000, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "buffer-alpha"
    )
    val rotationDegrees = -32f
    BoxWithConstraints(modifier = modifier.clipToBounds()) {
        val density = LocalDensity.current
        val textMeasurer = rememberTextMeasurer()
        val baseFontSizeSp = 100f
        val measuredSize = remember {
            textMeasurer.measure(
                text = "BUFFER",
                style = TextStyle(fontSize = baseFontSizeSp.sp, fontWeight = FontWeight.Bold)
            ).size
        }
        val zoneWidthPx = with(density) { maxWidth.toPx() }
        val zoneHeightPx = with(density) { maxHeight.toPx() }
        val angleRad = Math.toRadians(-rotationDegrees.toDouble())
        val cos = cos(angleRad).toFloat()
        val sin = sin(angleRad).toFloat()
        // Rotating a W x H box by angleRad gives a bounding box of
        // (W*cos + H*sin) x (W*sin + H*cos) - solve the scale factor
        // against both the zone's width and height constraints and take
        // whichever is smaller, so it's guaranteed to fit both ways
        // rather than just one.
        val scaleForWidth = zoneWidthPx / (measuredSize.width * cos + measuredSize.height * sin)
        val scaleForHeight = zoneHeightPx / (measuredSize.width * sin + measuredSize.height * cos)
        val fittedFontSizeSp = baseFontSizeSp * minOf(scaleForWidth, scaleForHeight)

        Text(
            text = "BUFFER",
            color = SpotifyColors.Green.copy(alpha = alpha),
            fontSize = fittedFontSizeSp.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            softWrap = false,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .offset(y = (-100).dp)
                .rotate(rotationDegrees)
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Seekbar(
    positionSeconds: Int,
    durationSeconds: Int,
    onSeekFinished: (Float) -> Unit
) {

    // null = not currently dragging, follow the server-reported
    // position; non-null = mid-drag, show the local value instead of
    // fighting the user's own gesture with the next poll tick
    var dragValue by remember { mutableStateOf<Float?>(null) }

    val serverFraction = if (durationSeconds > 0) {
        (positionSeconds.toFloat() / durationSeconds).coerceIn(0f, 1f)
    } else 0f

    // thin line track + thin line thumb (not a round ball) - matches
    // #seekbar's custom thumb shape in the original, chosen there so it
    // doesn't visually compete with hlsPositionMarker
    Slider(
        value = dragValue ?: serverFraction,
        onValueChange = { dragValue = it },
        onValueChangeFinished = {
            dragValue?.let(onSeekFinished)
            dragValue = null
        },
        // .seekbar-wrap { height:16px; margin:12px auto 25px } in the
        // original - Material3's Slider reserves a much taller default
        // touch target around its visible track, which was pushing the
        // whole thing well below #time's own 12px gap even with the
        // small 4dp padding this used to have. An explicit 16dp height
        // (not just padding) overrides that default sizing outright.
        // padding() BEFORE height() is load-bearing here, not just
        // style - Modifier order applies outside-in, so height() first
        // would instead constrain the whole box to 16dp and then eat
        // INTO that fixed 16dp with the padding (12+25=37dp, more than
        // the box itself), squeezing the actual slider almost to
        // nothing instead of sitting in a real 16dp box with real
        // margin-like space around it.
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 12.dp, bottom = 25.dp)
            .height(16.dp),
        track = { sliderState ->
            SliderDefaults.Track(
                sliderState = sliderState,
                modifier = Modifier.height(6.dp),
                colors = SliderDefaults.colors(
                    activeTrackColor = SpotifyColors.TextPrimary,
                    inactiveTrackColor = SpotifyColors.TrackLine
                ),
                thumbTrackGapSize = 0.dp,
                drawStopIndicator = null
            )
        },
        thumb = {
            Box(
                Modifier
                    .width(3.dp)
                    .height(16.dp)
                    .background(SpotifyColors.TextPrimary, RoundedCornerShape(1.dp))
            )
        }
    )

}

private fun formatSeconds(totalSeconds: Int): String {
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return "$minutes:${seconds.toString().padStart(2, '0')}"
}
