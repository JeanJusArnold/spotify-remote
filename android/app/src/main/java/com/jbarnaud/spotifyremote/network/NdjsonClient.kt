package com.jbarnaud.spotifyremote.network

import com.jbarnaud.spotifyremote.network.dto.NdjsonChunk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

// Line-delimited JSON reader for server.js's NDJSON endpoints (/artist,
// /current-artist, /playlist-more, /library-more) - one JSON object per
// line. Retrofit has no first-class line-streaming abstraction, so this
// is raw OkHttp instead, sharing the same client (and so the same
// DynamicBaseUrlInterceptor rewriting) Retrofit uses - "http://localhost"
// here is the same never-actually-dialed placeholder host as
// NetworkModule's Retrofit base URL.
@Singleton
class NdjsonClient @Inject constructor(
    private val okHttpClient: OkHttpClient,
    // needs to be visible from the inline reified stream() function
    // below (its lambda is inlined at every call site, outside this
    // class, so a plain `private` here fails to compile there)
    @PublishedApi internal val json: Json
) {

    inline fun <reified T : NdjsonChunk> stream(
        path: String,
        queryParams: Map<String, String> = emptyMap()
    ): Flow<T> = streamInternal(path, queryParams) { line -> json.decodeFromString(line) }

    // the reified overload above can't itself be the callbackFlow body
    // without duplicating the OkHttp plumbing per call site - factor
    // that out into this non-reified helper, taking the already-bound
    // deserializer as a plain lambda instead
    fun <T : NdjsonChunk> streamInternal(
        path: String,
        queryParams: Map<String, String>,
        deserialize: (String) -> T
    ): Flow<T> = callbackFlow {

        val urlBuilder = "http://localhost/".toHttpUrl().newBuilder()
            .addPathSegments(path.removePrefix("/"))
        queryParams.forEach { (key, value) -> urlBuilder.addQueryParameter(key, value) }

        val request = Request.Builder().url(urlBuilder.build()).build()
        val call = okHttpClient.newCall(request)

        call.enqueue(object : Callback {

            override fun onFailure(call: Call, e: IOException) {
                close(e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    try {
                        val source = it.body?.source() ?: throw IOException("$path: empty body")
                        var sawDone = false
                        while (true) {
                            val line = source.readUtf8Line() ?: break
                            if (line.isBlank()) continue
                            val chunk = deserialize(line)
                            sawDone = chunk.done
                            trySend(chunk)
                        }
                        if (!sawDone) throw IOException("$path: stream ended without done:true")
                        close()
                    } catch (e: Exception) {
                        close(e)
                    }
                }
            }

        })

        awaitClose { call.cancel() }

    }.flowOn(Dispatchers.IO)

}
