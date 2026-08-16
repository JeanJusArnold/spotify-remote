package com.jbarnaud.spotifyremote.navigation

import android.net.Uri
import com.jbarnaud.spotifyremote.feature.browse.BrowseTarget

sealed class Destinations(val route: String) {
    data object NowPlaying : Destinations("now_playing")
    data object Search : Destinations("search")

    // one generic destination for every non-Search BrowseTarget. kind/id
    // are plain path segments (Spotify ids and library-type strings are
    // already URL-safe); title/cover are free text and need Uri encoding
    // since track/album/artist names (and cover URLs' query strings) can
    // contain "/", "&", "?", etc.
    data object Browse : Destinations("browse/{kind}/{id}?title={title}&cover={cover}") {

        fun routeFor(target: BrowseTarget): String {
            val (kind, id, title, cover) = when (target) {
                BrowseTarget.Home -> Quad("home", "-", "", "")
                BrowseTarget.WhatsNew -> Quad("whats_new", "-", "", "")
                is BrowseTarget.Artist -> Quad("artist", target.id, target.title, target.cover)
                is BrowseTarget.CurrentArtist -> Quad("current_artist", "-", target.title, "")
                is BrowseTarget.Album -> Quad("album", target.id, target.title, target.cover)
                BrowseTarget.CurrentAlbum -> Quad("current_album", "-", "", "")
                is BrowseTarget.Playlist -> Quad("playlist", target.id, target.title, target.cover)
                is BrowseTarget.Library -> Quad("library", target.libType, "", "")
                is BrowseTarget.LibraryFolder -> Quad("library_folder", target.id, target.title, "")
            }
            return "browse/$kind/${Uri.encode(id)}?title=${Uri.encode(title)}&cover=${Uri.encode(cover)}"
        }

    }
}

private data class Quad(val kind: String, val id: String, val title: String, val cover: String)

// Reconstructs the BrowseTarget a Browse screen instance was navigated
// to from its own NavBackStackEntry args - the inverse of
// Destinations.Browse.routeFor. "id" doubles as the library type string
// for the "library" kind, same dual purpose as in BrowseTarget itself.
fun browseTargetFromArgs(kind: String, id: String, title: String, cover: String): BrowseTarget = when (kind) {
    "home" -> BrowseTarget.Home
    "whats_new" -> BrowseTarget.WhatsNew
    "artist" -> BrowseTarget.Artist(id, title, cover)
    "current_artist" -> BrowseTarget.CurrentArtist(title)
    "album" -> BrowseTarget.Album(id, title, cover)
    "current_album" -> BrowseTarget.CurrentAlbum
    "playlist" -> BrowseTarget.Playlist(id, title, cover)
    "library" -> BrowseTarget.Library(id)
    "library_folder" -> BrowseTarget.LibraryFolder(id, title)
    else -> error("Unknown browse kind: $kind")
}
