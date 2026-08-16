package com.jbarnaud.spotifyremote.network.dto

import kotlinx.serialization.Serializable

// Mirrors server.js's GET /state response exactly - see server.js's
// /state route. position/duration are "m:ss" text, not seconds.
@Serializable
data class StateResponse(
    val title: String,
    val artist: String,
    val playing: Boolean,
    val position: String,
    val duration: String,
    val cover: String,
    val shuffle: Boolean,
    val repeat: String
)

// GET /play - shieldMs is 0 if nothing needs shielding, else the whole
// window (see ShieldController.armWholeDuration).
@Serializable
data class PlayResponse(
    val ok: Boolean,
    val shieldMs: Long
)

// GET /pause - pauseLandsInMs is WHEN the unsafe handoff lands, not a
// duration to shield immediately (see ShieldController.armBracketed).
@Serializable
data class PauseResponse(
    val ok: Boolean,
    val pauseLandsInMs: Long
)
