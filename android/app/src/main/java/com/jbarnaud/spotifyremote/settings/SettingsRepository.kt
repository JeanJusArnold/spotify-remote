package com.jbarnaud.spotifyremote.settings

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.jbarnaud.spotifyremote.di.ApplicationScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import javax.inject.Inject
import javax.inject.Singleton

val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

private val BASE_URL_KEY = stringPreferencesKey("base_url")

// The server address is a runtime-editable setting, not baked into the
// build - the app is meant to be shareable with people running their
// own server, not hardcoded to one machine. currentBaseUrl mirrors the
// DataStore value into a StateFlow so the network layer's interceptor
// (see NetworkModule) can read it synchronously per-request without
// blocking on a suspend DataStore read for every single HTTP call.
@Singleton
class SettingsRepository @Inject constructor(
    private val dataStore: DataStore<Preferences>,
    @ApplicationScope scope: CoroutineScope
) {

    val baseUrlFlow: Flow<String?> = dataStore.data.map { it[BASE_URL_KEY] }

    private val _currentBaseUrl = MutableStateFlow<String?>(null)
    val currentBaseUrl: StateFlow<String?> = _currentBaseUrl.asStateFlow()

    // distinguishes "not read from disk yet" from "read, and there
    // genuinely isn't one saved" - without this, app start would flash
    // the settings screen for a frame even when a URL was already saved,
    // since currentBaseUrl starts at null until the first DataStore
    // emission arrives
    private val _isLoaded = MutableStateFlow(false)
    val isLoaded: StateFlow<Boolean> = _isLoaded.asStateFlow()

    init {
        baseUrlFlow.onEach {
            _currentBaseUrl.value = it
            _isLoaded.value = true
        }.launchIn(scope)
    }

    suspend fun setBaseUrl(url: String) {
        dataStore.edit { it[BASE_URL_KEY] = url.trim() }
    }
}
