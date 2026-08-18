package com.jbarnaud.spotifyremote.network

import com.jbarnaud.spotifyremote.network.dto.AlbumNameResponse
import com.jbarnaud.spotifyremote.network.dto.BrowseItem
import com.jbarnaud.spotifyremote.network.dto.ContextAndQueueResponse
import com.jbarnaud.spotifyremote.network.dto.HomeSectionDto
import com.jbarnaud.spotifyremote.network.dto.LibraryResponse
import com.jbarnaud.spotifyremote.network.dto.PauseResponse
import com.jbarnaud.spotifyremote.network.dto.PlayResponse
import com.jbarnaud.spotifyremote.network.dto.PlaylistResponse
import com.jbarnaud.spotifyremote.network.dto.StateResponse
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Query

// Mirrors server.js's HTTP API exactly (verified against source, not
// guessed - see server.js). The NDJSON endpoints (/artist,
// /current-artist, /playlist-more, /library-more) go through
// NdjsonClient instead - Retrofit has no line-streaming abstraction.
interface ApiService {

    @GET("/play")
    suspend fun play(): PlayResponse

    @GET("/pause")
    suspend fun pause(): PauseResponse

    @GET("/next")
    suspend fun next(): Response<Unit>

    @GET("/previous")
    suspend fun previous(): Response<Unit>

    @GET("/shuffle")
    suspend fun shuffle(): Response<Unit>

    @GET("/repeat")
    suspend fun repeat(): Response<Unit>

    // percent must be 0.0-1.0 - server returns 400 "invalid percent"
    // outside that range, and has no try/catch of its own (can 500
    // uncaught on a missing seek bar), so callers must treat any
    // non-2xx defensively rather than assuming a clean error body.
    @GET("/seek")
    suspend fun seek(@Query("percent") percent: Float): Response<Unit>

    @GET("/state")
    suspend fun state(): StateResponse

    @GET("/search")
    suspend fun search(@Query("q") query: String): List<BrowseItem>

    @GET("/whats-new")
    suspend fun whatsNew(): List<BrowseItem>

    // direction hints (getDirectionHint in the web client, used for the
    // server's scroll-and-retry fallback on a virtualized-list tap miss)
    // are deliberately not ported - the server just defaults to
    // scanning "down" when omitted, same as an unresolved hint there
    @GET("/play-result")
    suspend fun playResult(@Query("id") id: String): Response<Unit>

    @GET("/current-album-name")
    suspend fun currentAlbumName(): AlbumNameResponse

    @GET("/current-album")
    suspend fun currentAlbum(): List<BrowseItem>

    @GET("/home")
    suspend fun home(): List<HomeSectionDto>

    @GET("/home-section")
    suspend fun homeSection(@Query("index") index: Int): List<BrowseItem>

    @GET("/album")
    suspend fun album(@Query("id") id: String): List<BrowseItem>

    @GET("/playlist")
    suspend fun playlist(@Query("id") id: String): PlaylistResponse

    @GET("/library")
    suspend fun library(@Query("type") type: String): LibraryResponse

    @GET("/library-folder")
    suspend fun libraryFolder(@Query("id") id: String): List<BrowseItem>

    // exitFolder=1 clicks the sidebar's real "Retour" button once
    // (safe/no-op if not currently in a folder); omitted just re-reads
    // whatever the sidebar already shows - see server.js's /library-back
    // and BrowseViewModel's onResumed() re-sync logic for why this
    // matters (the sidebar's real navigation state persists server-side
    // independent of what this app's back stack shows).
    @GET("/library-back")
    suspend fun libraryBack(@Query("exitFolder") exitFolder: Int? = null): List<BrowseItem>

    // reads the webplayer's own queue panel - only meaningful once the
    // panel's been opened server-side, which this endpoint does itself
    // on demand (see getContextAndQueue in server.js)
    @GET("/context-and-queue")
    suspend fun contextAndQueue(): ContextAndQueueResponse

    // list is "queue" (algorithmic "up next") or "manual" (explicitly
    // queued via queueAdd) - index is positional within that list, not a
    // stable id, since the scrape has none to give. title/subtitle are
    // what onQueueItemClick expected to find at that index at tap time -
    // the server verifies against the live queue and searches by these
    // instead of trusting a stale index if the real queue shifted
    // (auto-advance) between the last poll and the tap - unlike
    // queueRemove below, silently playing the wrong track is worse than
    // a failed remove, so this one self-corrects rather than just
    // reporting "not found"
    @GET("/queue-play")
    suspend fun queuePlay(
        @Query("index") index: Int,
        @Query("list") list: String,
        @Query("title") title: String,
        @Query("subtitle") subtitle: String
    ): Response<Unit>

    // "not found" is a 200 here, not a 404 (index shifted under a stale
    // client view, or the row's own "more options"/menu-item lookup
    // failed) - callers must read the body text, not just the status,
    // matching queue-remove's own res.send(clicked ? "ok" : "not found")
    @GET("/queue-remove")
    suspend fun queueRemove(@Query("index") index: Int, @Query("list") list: String): Response<ResponseBody>

    // direction hint omitted, same reasoning as playResult above
    @GET("/queue-add")
    suspend fun queueAdd(@Query("id") id: String): Response<Unit>

    // server accepts "url" or "text" - "text" also happens to work for a
    // raw https://open.spotify.com/... deep link, not just a shared
    // sentence containing one, so a single param covers both the
    // ACTION_SEND and ACTION_VIEW entry points. 400 (no link found in
    // the text) and 500 (scrape failure) are both real, expected
    // non-crash outcomes here - Response<> wrapper, not a bare suspend
    // return, so callers read isSuccessful instead of catching. The
    // response body shape ({id, type, title, subtitle, cover}) is
    // exactly BrowseItem's own shape (meta just comes back absent,
    // which its default handles), so no separate DTO is needed.
    @GET("/resolve-link")
    suspend fun resolveLink(@Query("text") text: String): Response<BrowseItem>
}
