package com.jbarnaud.spotifyremote.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val SpotifyGreen = Color(0xFF1DB954)

private val DarkColors = darkColorScheme(
    primary = SpotifyGreen,
    background = Color(0xFF111111),
    surface = Color(0xFF111111)
)

private val LightColors = lightColorScheme(
    primary = SpotifyGreen
)

@Composable
fun SpotifyRemoteTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content
    )
}
