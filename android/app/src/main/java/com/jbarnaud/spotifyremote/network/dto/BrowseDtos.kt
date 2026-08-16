package com.jbarnaud.spotifyremote.network.dto

import kotlinx.serialization.Serializable

// Mirrors the shape server.js's various scrape* functions return
// (scrapeVisibleTracklistRows, scrapeVisibleLibraryRows,
// scrapeDiscographyCardsInView, scrapeWhatsNewRows, /search,
// /home-section) - type is "artist"|"album"|"playlist"|"track"|"folder"
// and drives navigate-vs-play in BrowseViewModel.onItemClick.
@Serializable
data class BrowseItem(
    val id: String,
    val type: String,
    val title: String,
    val subtitle: String,
    val cover: String,
    val meta: String? = null
)

// Common shape of every NDJSON line the server sends - lets
// NdjsonClient check "done" without knowing the concrete chunk type. A
// stream that ends without a final done:true line is a confirmed real
// server failure mode (headers already sent, then an error - the
// response just ends), not "no more data" - see NdjsonClient.
interface NdjsonChunk {
    val done: Boolean
}

// GET /artist and /current-artist - one line per progressive render,
// see scrapeArtistDiscography/categorizeReleases.
@Serializable
data class DiscographyChunk(
    val albums: List<BrowseItem>,
    val singles: List<BrowseItem>,
    val compilations: List<BrowseItem>,
    override val done: Boolean
) : NdjsonChunk

// GET /playlist
@Serializable
data class PlaylistResponse(
    val tracks: List<BrowseItem>,
    val atTop: Boolean,
    val atBottom: Boolean
)

// GET /playlist-more - NDJSON-shaped but always exactly one line
@Serializable
data class PlaylistMoreChunk(
    val tracks: List<BrowseItem>,
    override val done: Boolean
) : NdjsonChunk

// GET /library
@Serializable
data class LibraryResponse(
    val tracks: List<BrowseItem>,
    val atTop: Boolean,
    val atBottom: Boolean
)

// GET /library-more - NDJSON-shaped but always exactly one line
@Serializable
data class LibraryMoreChunk(
    val tracks: List<BrowseItem>,
    override val done: Boolean
) : NdjsonChunk

// GET /home
@Serializable
data class HomeSectionDto(val heading: String)

// GET /current-album-name
@Serializable
data class AlbumNameResponse(val name: String)

// GET /context-and-queue - see getContextAndQueue in server.js. No id
// (server reads these off the queue panel's DOM, which doesn't expose
// one) or type (queue entries are always plain tracks) - just enough to
// render a row and play/remove it by its position in the list.
@Serializable
data class QueueItemDto(val title: String, val subtitle: String, val cover: String)

@Serializable
data class ContextAndQueueResponse(
    val context: String,
    val queue: List<QueueItemDto>,
    val manualQueue: List<QueueItemDto>
)
