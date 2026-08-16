package com.jbarnaud.spotifyremote.network

import com.jbarnaud.spotifyremote.settings.SettingsRepository
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException
import javax.inject.Inject

// Retrofit needs a base URL at construction time, but the real server
// address is a runtime setting (see SettingsRepository) - this rewrites
// the scheme/host/port of every outgoing request to whatever's
// currently configured, so Retrofit's own base URL is just a
// placeholder that's never actually used to reach the network.
class DynamicBaseUrlInterceptor @Inject constructor(
    private val settingsRepository: SettingsRepository
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {

        val configured = settingsRepository.currentBaseUrl.value
            ?: throw IOException("Server address not configured yet")

        val configuredUrl = configured.toHttpUrlOrNull()
            ?: throw IOException("Invalid server address: $configured")

        val original = chain.request()
        val redirected = original.url.newBuilder()
            .scheme(configuredUrl.scheme)
            .host(configuredUrl.host)
            .port(configuredUrl.port)
            .build()

        return chain.proceed(original.newBuilder().url(redirected).build())

    }

}
