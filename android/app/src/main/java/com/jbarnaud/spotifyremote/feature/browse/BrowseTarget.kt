package com.jbarnaud.spotifyremote.feature.browse

// One generic browse destination, parameterized by this - mirrors the
// web client's view descriptors (recordView in player.js) but as a real
// type instead of an untyped {type, ...} object. Search isn't here: it
// owns live user text input, not a fixed id/title from nav args, so it
// gets its own screen/ViewModel rather than going through this.
//
// Threads the web client's "fallback cover" (applyFallbackCovers in
// player.js) through nav args: browseArtist/browseAlbum/browsePlaylist
// (and their "current" variants, and playlist load-more) all backfill
// any item missing its own cover with the cover of whatever was tapped
// to get here - individual tracks inside an album/playlist scrape often
// don't carry their own art, so without this every row in those lists
// renders with no thumbnail at all. Home/WhatsNew/Library/LibraryFolder
// never call applyFallbackCovers in the original (their items are real
// distinct entities that already carry their own art), so they don't
// need a cover param here either.
sealed interface BrowseTarget {
    data object Home : BrowseTarget
    data object WhatsNew : BrowseTarget
    data class Artist(val id: String, val title: String, val cover: String = "") : BrowseTarget
    data class CurrentArtist(val title: String) : BrowseTarget
    data class Album(val id: String, val title: String, val cover: String = "") : BrowseTarget
    data object CurrentAlbum : BrowseTarget
    data class Playlist(val id: String, val title: String, val cover: String = "") : BrowseTarget
    data class Library(val libType: String) : BrowseTarget
    data class LibraryFolder(val id: String, val title: String) : BrowseTarget
}

val libraryTypeLabels = mapOf(
    "playlists" to "Playlists",
    "artists" to "Artistes",
    "albums" to "Albums"
)
