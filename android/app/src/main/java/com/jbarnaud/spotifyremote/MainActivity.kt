package com.jbarnaud.spotifyremote

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.jbarnaud.spotifyremote.navigation.AppRoot
import com.jbarnaud.spotifyremote.state.SharedLinkController
import com.jbarnaud.spotifyremote.ui.theme.SpotifyRemoteTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

// launchMode="singleTask" (set in AndroidManifest.xml) is what actually
// prevents the reload-on-reopen / duplicate-window problems the PWA
// version had - reopening via the launcher icon, tapping a
// open.spotify.com link (ACTION_VIEW), or sharing one to the app
// (ACTION_SEND) all route into this same existing instance via
// onNewIntent rather than spawning a new one.
@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var sharedLinkController: SharedLinkController

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIncomingIntent(intent)
        setContent {
            SpotifyRemoteTheme {
                AppRoot()
            }
        }
    }

    // singleTask delivers a relaunch (icon tap while already open, a
    // fresh link tap, a fresh share) here instead of a new onCreate -
    // without this override, only the very first link/share of the
    // app's process lifetime would ever be picked up.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIncomingIntent(intent)
    }

    // ACTION_SEND (share sheet, text/plain) carries the shared text as
    // EXTRA_TEXT - it may be a bare link or a whole sentence containing
    // one, /resolve-link's own regex handles both. ACTION_VIEW (tapping
    // a https://open.spotify.com/... link directly) carries the link
    // itself as the intent's data URI instead - there is no EXTRA_TEXT
    // on that path.
    private fun handleIncomingIntent(intent: Intent?) {
        val raw = when (intent?.action) {
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
            Intent.ACTION_VIEW -> intent.dataString
            else -> null
        }
        if (!raw.isNullOrBlank()) sharedLinkController.submit(raw)
    }

}
