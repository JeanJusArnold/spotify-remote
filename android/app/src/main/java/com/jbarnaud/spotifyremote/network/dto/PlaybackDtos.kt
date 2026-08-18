package com.jbarnaud.spotifyremote.network.dto

import kotlinx.serialization.Serializable

// Mirrors server.js's GET /state response exactly - see server.js's
// /state route. position/duration are "m:ss" text, not seconds.
// mprisBlocked: true while the server is mid-resumeHlsEncoder or in the
// committed tail of pauseSpotifyAndEncoder - a real, server-enforced
// state (a conflicting /play or /pause is rejected with 409 while this
// is true), not a client-side prediction. Drive the play/pause button's
// disabled state directly off this instead of a local timer - see
// NowPlayingViewModel.uiState.
@Serializable
data class StateResponse(
    val title: String,
    val artist: String,
    val playing: Boolean,
    val position: String,
    val duration: String,
    val cover: String,
    val shuffle: Boolean,
    val repeat: String,
    val mprisBlocked: Boolean = false
)

// GET /play - the server may reject with 409 (mpris_blocked) instead of
// this shape, see ApiService/StateResponse.mprisBlocked's own comment.
@Serializable
data class PlayResponse(
    val ok: Boolean
)

// GET /pause - same 409 rejection possibility as /play above.
// pauseLandsInMs is NOT for shielding (mprisBlocked replaced that) -
// it's still needed for NowPlayingViewModel's position-extrapolation
// display (pauseDeadlineElapsedMs), since the real PC-side Spotify
// position keeps advancing until this deferred pause actually lands.
@Serializable
data class PauseResponse(
    val ok: Boolean,
    val pauseLandsInMs: Long
)
