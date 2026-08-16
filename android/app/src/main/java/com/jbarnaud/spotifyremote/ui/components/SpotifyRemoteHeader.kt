package com.jbarnaud.spotifyremote.ui.components

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jbarnaud.spotifyremote.R
import com.jbarnaud.spotifyremote.ui.theme.SpotifyColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

private val TopbarBackground = Color(0xFF3A3A3A)
private val WatermarkGray = Color(0xFF565656)
private val KeyFace = Color(0xFF161616)
private val KeyFacePressed = Color(0xFF0D0D0D)
private val KeyBorder = Color(0xFF3D3D3D)

private const val TITLE = "spotify remote"

// Ported 1:1 from the original web client's topbar (public/index.html
// #topbar, public/css/style.css .topbar*, public/js/ui.js's key-cap
// rendering, public/js/player.js's startTypingAnimation/
// stopTypingAnimation): a big, mostly-cropped Spotify logo watermark
// behind "spotify remote" spelled out as individual keyboard keys, a
// second copy of the same logo tinted green that reveals from the
// bottom up while isLoading is true (the original's "fake" progress
// indicator - it's timed, not tied to real byte progress), and the keys
// individually "typed" in a repeating cycle for the same duration. The
// whole thing is one big tap target that browses Home, exactly like the
// original's topbar.addEventListener("click", browseHome).
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SpotifyRemoteHeader(
    isLoading: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {

    // Two separate CSS rules, not one symmetric transition: the base
    // .topbar::after (not loading) only has transition:clip-path 0.2s
    // ease-out, and .topbar.loading::after OVERRIDES that to 3.5s
    // cubic-bezier(0.15,0.6,0.3,1) only while .loading is present. CSS
    // always uses the transition duration of the rule being transitioned
    // INTO, so filling is the slow 3.5s ramp but reverting back to 0
    // uses the base rule's fast 0.2s instead - not a mirrored 3.5s
    // unwind. animationSpec is picked the same way here, keyed off
    // isLoading alongside the target value itself.
    val fillFraction by animateFloatAsState(
        targetValue = if (isLoading) 1f else 0f,
        animationSpec = if (isLoading) {
            tween(durationMillis = 3500, easing = CubicBezierEasing(0.15f, 0.6f, 0.3f, 1f))
        } else {
            tween(durationMillis = 200, easing = CubicBezierEasing(0f, 0f, 0.58f, 1f))
        },
        label = "logoFill"
    )

    var pressedKeyIndex by remember { mutableIntStateOf(-1) }

    // CSS: pressNext() cycles one .key.pressed at a time every 90ms,
    // wrapping via keys[i % keys.length] so it cycles forever. This port
    // dropped the % keys.length wrap for a long time - i just grew
    // unboundedly, so pressedKeyIndex only ever matched a real key
    // (0..totalKeys-1) during the very first ~1.2s of the app's/effect's
    // lifetime, then permanently stopped matching anything for the rest
    // of the session. Confirmed live via logcat: caught pressedKeyIndex
    // at 168-181, nowhere near any real key index. totalKeys below
    // brings back the same wraparound.
    val totalKeys = remember { TITLE.count { it != ' ' } }
    LaunchedEffect(isLoading) {
        if (isLoading) {
            var i = 0
            while (isActive) {
                pressedKeyIndex = i % totalKeys
                i++
                delay(90)
            }
        } else {
            pressedKeyIndex = -1
        }
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(TopbarBackground)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {

        // background-size: auto 320px in the original - a huge logo
        // mostly cropped away by the topbar's own (much shorter) height,
        // leaving only its central curves visible as an abstract
        // watermark rather than a recognizable full logo. matchParentSize
        // + clipToBounds is the Compose analog of that CSS cropping: this
        // Box is excluded from the outer Box's own size calculation (so
        // the header's real height stays driven only by the keycap
        // FlowRow's own size, padding included - see below), and crops
        // whatever overflows it. The vertical padding used to live here,
        // on this root Box's own modifier chain - that shrank the
        // constraints these matchParentSize layers got measured with,
        // so the crop stopped at the padding's inner edge instead of the
        // header's true outer edge, leaving a flat unrecropped band at
        // top and bottom. Moving the padding onto the FlowRow itself
        // (below) keeps the same visible key layout while letting these
        // layers match the header's real full height.
        // requiredSize (not size!) is load-bearing here - a plain .size()
        // is only a *preference* that Compose still shrinks to fit
        // whatever max constraint the matchParentSize box above passes
        // down, so the icon was silently being squashed to the header's
        // own small height instead of actually overflowing it.
        // requiredSize forces the true 320dp regardless of the incoming
        // constraint, so it genuinely overflows top and bottom and
        // clipToBounds has something real to crop.
        Box(
            modifier = Modifier
                .matchParentSize()
                .clipToBounds(),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                painterResource(R.drawable.ic_spotify_logo),
                contentDescription = null,
                tint = WatermarkGray,
                modifier = Modifier.requiredSize(320.dp)
            )
        }

        // clip-path's percentage in the original is relative to
        // .topbar::after's OWN box (position:absolute;inset:0, i.e. the
        // real header height) - NOT relative to the 320px background-
        // image itself, which is shorter than that box and just sits
        // centered inside it. Clipping relative to the much-taller
        // 320dp icon instead (as this used to) only needs a small
        // fraction of fillFraction to clear the header's real, much
        // shorter window - the reveal looked visually finished after
        // ~500ms instead of still animating for nearly the network
        // wait's full length, which is what made this look "stuck" at
        // full green long before the request actually finished. This
        // clipRect now measures against `size` = the outer window
        // itself (matchParentSize's own size), matching the original's
        // reference box exactly.
        Box(
            modifier = Modifier
                .matchParentSize()
                .drawWithContent {
                    clipRect(top = size.height * (1f - fillFraction)) {
                        this@drawWithContent.drawContent()
                    }
                },
            contentAlignment = Alignment.Center
        ) {
            Icon(
                painterResource(R.drawable.ic_spotify_logo),
                contentDescription = null,
                tint = SpotifyColors.Green,
                modifier = Modifier.requiredSize(320.dp)
            )
        }

        var keyIndex = -1
        // CSS: .word { display:inline-block; white-space:nowrap } - each
        // word never breaks across its own letters, but wraps onto its
        // own line as a whole once the two words together don't fit a
        // narrow phone's width (matches FlowRow's default per-item
        // wrapping exactly)
        FlowRow(
            modifier = Modifier.fillMaxWidth().padding(vertical = 18.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            TITLE.split(" ").forEach { word ->
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    word.forEach { letter ->
                        keyIndex++
                        KeyCap(letter = letter, pressed = keyIndex == pressedKeyIndex)
                    }
                }
            }
        }

    }

}

// One "spotify remote" letter, styled like a small mechanical keyboard
// key (CSS .key/.key.pressed) - a solid shadow slab behind a face that
// drops down onto it (translateY + shadow removal) when pressed, rather
// than a blurred Material-style shadow.
@Composable
private fun KeyCap(letter: Char, pressed: Boolean) {

    // instant, not animated - the original CSS (.key.pressed) has no
    // transition at all, a plain snap. animateDpAsState here (~300ms to
    // settle by default) meant the press motion never had time to
    // complete before reversing again during the 90ms-per-key typing
    // cycle - confirmed live: the state itself was cycling correctly
    // (logcat), the animation lag is what made it invisible.
    val faceOffset = if (pressed) 4.dp else 0.dp

    Box(modifier = Modifier.size(34.dp)) {

        Box(
            modifier = Modifier
                .size(34.dp)
                .offset(y = 4.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(Color.Black)
        )

        Box(
            modifier = Modifier
                .size(34.dp)
                .offset(y = faceOffset)
                .clip(RoundedCornerShape(6.dp))
                .background(if (pressed) KeyFacePressed else KeyFace)
                .border(1.dp, KeyBorder, RoundedCornerShape(6.dp)),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = letter.toString(),
                color = Color.White,
                fontWeight = FontWeight.Black,
                fontSize = 18.sp
            )
        }

    }

}
