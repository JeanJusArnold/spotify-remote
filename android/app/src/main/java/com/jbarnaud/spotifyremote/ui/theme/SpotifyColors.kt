package com.jbarnaud.spotifyremote.ui.theme

import androidx.compose.ui.graphics.Color

// Named constants matching the original web client's hand-tuned palette
// (public/css/style.css) exactly, rather than deriving screen colors from
// Material3's generic ColorScheme roles - the original deliberately isn't
// a Material-style app (solid circular play button, thin-line seekbar,
// flat dense list rows) and reusing these across every screen (Browse
// included) is what keeps that identity consistent instead of drifting
// back toward Material defaults screen by screen.
object SpotifyColors {
    val Background = Color(0xFF111111)
    val Surface = Color(0xFF111111)
    val Sheet = Color(0xFF282828)
    val TextPrimary = Color.White
    val TextSecondary = Color(0xFFAAAAAA)
    val TextTertiary = Color(0xFF777777)
    val Divider = Color(0xFF222222)
    val TrackLine = Color(0xFF555555)
    val Green = Color(0xFF1DB954)
    // exact match for the original's #searchInput { border:1px solid
    // #333 } - deliberately not TrackLine (#555), which is a full step
    // lighter and reads as too strong a contrast against the ghost
    // layer's #222 background
    val SearchBorder = Color(0xFF333333)
}
