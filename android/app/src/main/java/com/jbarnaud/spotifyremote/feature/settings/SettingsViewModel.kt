package com.jbarnaud.spotifyremote.feature.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.jbarnaud.spotifyremote.settings.SettingsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val settingsRepository: SettingsRepository
) : ViewModel() {

    private val _input = MutableStateFlow("")
    val input: StateFlow<String> = _input.asStateFlow()

    private val _saved = MutableStateFlow(false)
    val saved: StateFlow<Boolean> = _saved.asStateFlow()

    init {
        viewModelScope.launch {
            settingsRepository.baseUrlFlow.first()?.let { _input.value = it }
        }
    }

    fun onInputChange(value: String) {
        _input.value = value
        _saved.value = false
    }

    // SettingsScreen's LaunchedEffect(saved) closes the overlay the
    // moment this is true - without resetting it back here, it would
    // stay true forever (this ViewModel is Activity-scoped, not tied to
    // the overlay's own show/hide, so it survives being reopened) and
    // every later reopen of Settings would auto-close itself instantly,
    // confirmed live while testing the "Fonctionnalités cachées" panel.
    fun acknowledgeSaved() {
        _saved.value = false
    }

    // accepts "host:3000", "host", or a full "http://host:3000" - a
    // scheme is prepended if the user didn't type one (the server is
    // plain HTTP, see NetworkModule/server.js), and the server's own
    // fixed port is appended too if missing - the whole point being
    // that pasting a bare Tailscale IP straight out of the Tailscale
    // app, with nothing else typed, is enough on its own.
    fun save() {
        val raw = _input.value.trim()
        if (raw.isEmpty()) return

        val withScheme = if (raw.startsWith("http://") || raw.startsWith("https://")) {
            raw
        } else {
            "http://$raw"
        }

        val host = withScheme.substringAfter("://")
        val normalized = if (host.contains(":")) withScheme else "$withScheme:$DEFAULT_PORT"

        viewModelScope.launch {
            settingsRepository.setBaseUrl(normalized)
            _input.value = normalized
            _saved.value = true
        }
    }

    private companion object {
        // matches server.js's own PORT constant
        const val DEFAULT_PORT = 3000
    }

}
