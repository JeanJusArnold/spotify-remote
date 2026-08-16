package com.jbarnaud.spotifyremote.di

import com.jbarnaud.spotifyremote.network.ApiService
import com.jbarnaud.spotifyremote.network.DynamicBaseUrlInterceptor
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    // never actually dialed - DynamicBaseUrlInterceptor rewrites every
    // request's scheme/host/port to the real, user-configured address
    // before it goes out. Retrofit just requires *some* valid base URL.
    private const val PLACEHOLDER_BASE_URL = "http://localhost/"

    @Provides
    @Singleton
    fun provideJson(): Json = Json {
        ignoreUnknownKeys = true
    }

    @Provides
    @Singleton
    fun provideOkHttpClient(
        dynamicBaseUrlInterceptor: DynamicBaseUrlInterceptor
    ): OkHttpClient =
        OkHttpClient.Builder()
            .addInterceptor(dynamicBaseUrlInterceptor)
            .addInterceptor(HttpLoggingInterceptor().apply {
                level = HttpLoggingInterceptor.Level.BASIC
            })
            // the NDJSON artist-discography stream (milestone 3) can
            // legitimately hold the connection open for a while for
            // large discographies - generous read timeout
            .readTimeout(30, TimeUnit.SECONDS)
            // No pingInterval here - deliberately. A first attempt used
            // one (30s) to catch the /state-stream WebSocket silently
            // dying (a NAT/Tailscale hiccup with no clean close), but
            // that's mostly redundant: Tailscale's own WireGuard
            // keepalive (~25s) already keeps the underlying tunnel
            // itself alive, so our own ping was just adding a second,
            // near-identical wake-up on top of one that was already
            // happening. What's actually worth checking - is THIS
            // specific WebSocket session still good, as opposed to the
            // tunnel underneath it - only matters at the moment someone
            // would notice it's stale, i.e. when the app comes back to
            // the foreground (see PlaybackService's own foreground
            // reconnect check), not continuously in the background.
            .build()

    @Provides
    @Singleton
    fun provideRetrofit(okHttpClient: OkHttpClient, json: Json): Retrofit =
        Retrofit.Builder()
            .baseUrl(PLACEHOLDER_BASE_URL)
            .client(okHttpClient)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()

    @Provides
    @Singleton
    fun provideApiService(retrofit: Retrofit): ApiService =
        retrofit.create(ApiService::class.java)

}
