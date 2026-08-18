package com.jbarnaud.spotifyremote.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.jbarnaud.spotifyremote.ui.theme.SpotifyColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// replaces the old long-press-to-add/remove interaction on queue-able
// rows (BrowseResultRow, QueueRow) - a long-press is too easy to
// trigger by accident while scrolling a list; a deliberate left-to-
// right drag isn't. No background veil - confirmed live that read as
// unclear which the swiped-past state a bare color rectangle vs. its
// "did this actually confirm" moment, so the feedback is real content
// instead: the row's own [label] ("Ajouter"/"Retirer") fades in as you
// drag, and a checkmark replaces it once the drag has gone the full
// SwipeCommitDistance and you let go.
private val SwipeCommitDistance: Dp = 160.dp

@Composable
fun SwipeToConfirmRow(
    onClick: () -> Unit,
    swipeEnabled: Boolean,
    label: String,
    onConfirm: () -> Unit,
    // matches the row's own cover art size - the overlay's whole point
    // is to read as "big," so it's sized off something already known to
    // look right in that row rather than a fixed guess (48dp read as too
    // small in BrowseResultRow, confirmed live).
    coverSize: Dp,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(0.dp),
    content: @Composable RowScope.() -> Unit
) {

    val density = LocalDensity.current
    val commitPx = with(density) { SwipeCommitDistance.toPx() }
    // a Dp-to-Sp conversion alone (1 dp == 1 sp at default font scale)
    // sizes the font's full em box to coverSize, but the visible glyph
    // (cap height) only fills roughly 70% of that box for most fonts -
    // scale up so the LETTERS themselves reach coverSize, not just their
    // invisible line box.
    val labelFontSize = with(density) { (coverSize / 0.75f).toSp() }
    val progress = remember { Animatable(0f) }
    var confirmed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Box(modifier) {

        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .let { rowModifier ->
                    if (!swipeEnabled) rowModifier else rowModifier.draggable(
                        state = rememberDraggableState { delta ->
                            scope.launch {
                                progress.snapTo((progress.value + delta / commitPx).coerceIn(0f, 1f))
                            }
                        },
                        orientation = Orientation.Horizontal,
                        onDragStopped = {
                            if (progress.value >= 1f) {
                                onConfirm()
                                confirmed = true
                                delay(500)
                                progress.animateTo(0f, tween(durationMillis = 300))
                                confirmed = false
                            } else {
                                progress.animateTo(0f, tween(durationMillis = 200))
                            }
                        }
                    )
                }
                .padding(contentPadding),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            content = content
        )

        if (swipeEnabled && progress.value > 0f) {
            Box(
                // matchParentSize, not fillMaxSize - this overlay is a
                // sibling of Row inside the same Box, so fillMaxSize
                // still counted toward the Box's OWN size calculation.
                // At labelFontSize (coverSize/0.7, now over 60sp with
                // the bigger cover art) that label is taller than the
                // actual row, pushing the Box taller than the Row and
                // leaving visible empty space below it. matchParentSize
                // sizes to the Box's size AFTER its other content is
                // measured, without itself counting toward that size.
                Modifier
                    .matchParentSize()
                    .alpha(progress.value),
                contentAlignment = Alignment.Center
            ) {
                if (confirmed) {
                    Checkmark(size = coverSize, color = SpotifyColors.Green)
                } else {
                    Text(
                        label.uppercase(),
                        color = SpotifyColors.Green,
                        fontWeight = FontWeight.Bold,
                        fontSize = labelFontSize,
                        maxLines = 1,
                        // includeFontPadding=false alone still leaves the
                        // glyph off-center within its own line box -
                        // Android's font metrics reserve more descent
                        // space below the baseline than ascent space
                        // above it (see SearchFieldTextStyle's own
                        // comment), invisible at body text sizes but
                        // obvious at labelFontSize (60sp+). Trimming the
                        // line height to the glyph itself and centering
                        // within it is what actually centers the visible
                        // ink, not just the line box, inside this Box's
                        // own contentAlignment=Center.
                        style = TextStyle(
                            platformStyle = PlatformTextStyle(includeFontPadding = false),
                            lineHeight = labelFontSize,
                            lineHeightStyle = LineHeightStyle(
                                alignment = LineHeightStyle.Alignment.Center,
                                trim = LineHeightStyle.Trim.Both
                            )
                        )
                    )
                }
            }
        }

    }

}

// Icons.Filled.Check was too timid even boosted well past coverSize
// (confirmed live) - its actual stroke sits well inside its 24dp
// viewport with real baked-in padding around it that scaling the box
// can't remove, since it's part of the vector path itself, not the
// layout size. Drawn by hand instead: the path spans corner-to-corner
// of [size] itself (no inset budgeted for margin, only for the stroke's
// own rounded caps not to clip), and the stroke is proportional to
// [size] so it stays visually bold at any coverSize rather than a fixed
// width that would look thin blown up this large.
@Composable
private fun Checkmark(size: Dp, color: Color) {
    Canvas(modifier = Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val strokeWidthPx = this.size.minDimension * 0.16f
        val path = Path().apply {
            moveTo(w * 0.02f, h * 0.55f)
            lineTo(w * 0.38f, h * 0.92f)
            lineTo(w * 0.98f, h * 0.08f)
        }
        drawPath(
            path = path,
            color = color,
            style = Stroke(width = strokeWidthPx, cap = StrokeCap.Round, join = StrokeJoin.Round)
        )
    }
}
