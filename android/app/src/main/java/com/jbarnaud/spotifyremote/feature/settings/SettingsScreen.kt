package com.jbarnaud.spotifyremote.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.jbarnaud.spotifyremote.feature.browse.CollapsibleSection
import com.jbarnaud.spotifyremote.ui.theme.SpotifyColors

@Composable
fun SettingsScreen(
    onSaved: () -> Unit = {},
    viewModel: SettingsViewModel = hiltViewModel()
) {

    val input by viewModel.input.collectAsState()
    val saved by viewModel.saved.collectAsState()

    LaunchedEffect(saved) {
        if (saved) {
            onSaved()
            viewModel.acknowledgeSaved()
        }
    }

    Scaffold { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(
                text = "Adresse du serveur",
                style = MaterialTheme.typography.headlineSmall
            )
            Text(
                text = "Nom Tailscale ou IP du PC - collez juste l'adresse telle quelle, " +
                    "\"http://\" et le port sont ajoutés automatiquement.",
                style = MaterialTheme.typography.bodyMedium
            )
            OutlinedTextField(
                value = input,
                onValueChange = viewModel::onInputChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Adresse") },
                singleLine = true
            )
            Button(
                onClick = viewModel::save,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Enregistrer")
            }

            // fills the rest of the screen below the address form -
            // weight(1f) claims that space whether collapsed (mostly
            // empty, just the header) or expanded, so the header doesn't
            // jump position when toggled. verticalScroll rather than a
            // fixed layout since this list is meant to grow over time as
            // more non-obvious features get added.
            var hiddenFeaturesExpanded by remember { mutableStateOf(false) }
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
            ) {
                CollapsibleSection(
                    heading = "Fonctionnalités cachées",
                    expanded = hiddenFeaturesExpanded,
                    onToggle = { hiddenFeaturesExpanded = !hiddenFeaturesExpanded }
                ) {
                    Column(
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(18.dp)
                    ) {
                        HiddenFeature(
                            title = "Raccourcis de recherche",
                            description = "P  = vos playlists\n" +
                                "Ar = vos artistes\n" +
                                "Al = vos albums\n" +
                                "N  = vos nouveautés"
                        )
                        HiddenFeature(
                            title = "Liens Spotify",
                            description = "Cliquer sur un lien Spotify fonctionne avec cette " +
                                "application, il vous suffit de configurer l'ouverture des liens " +
                                "une fois : Réglages du téléphone → Applications → Spotify " +
                                "Remote → \"Ouvrir par défaut\" → Ajouter un lien → cocher " +
                                "open.spotify.com. À refaire si vous réinstallez l'app. Le " +
                                "partage (\"Partager\" → Spotify Remote) fonctionne aussi, sans " +
                                "configuration."
                        )
                        HiddenFeature(
                            title = "Pochette \"en cours de lecture\"",
                            description = "Premier appui : aperçu du nom de l'album dans la barre " +
                                "de recherche. Second appui : ouvre l'album."
                        )
                        HiddenFeature(
                            title = "File d'attente",
                            description = "Slide vers la droite sur un morceau (recherche ou " +
                                "navigation) : l'ajouter à la file. Slide vers la droite sur un " +
                                "élément de \"À suivre\" ou \"Ajoutés manuellement\" : le retirer."
                        )
                        HiddenFeature(
                            title = "Menus de l'accueil",
                            description = "Toucher le bandeau \"spotifyremote\" en haut de l'écran " +
                                "répertorie les différentes sections du menu d'accueil, depuis " +
                                "n'importe quel écran."
                        )
                    }
                }
            }
        }
    }

}

@Composable
private fun HiddenFeature(title: String, description: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, color = SpotifyColors.TextPrimary, fontWeight = FontWeight.Bold)
        Text(description, color = SpotifyColors.TextSecondary, style = MaterialTheme.typography.bodyMedium)
    }
}
