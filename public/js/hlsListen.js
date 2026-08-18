// Plays the DIY continuous audio relay from server.js - a plain
// Icecast/SHOUTcast-style ADTS-AAC stream now (see
// [[continuous_audio_relay_redesign]]), replacing an earlier hls.js-based
// version that played a segmented HLS manifest. No library needed any
// more: a browser's native <audio> element handles a continuous stream
// on its own, and there's no live-edge/segment-sync logic left to
// reimplement (see the deleted skipToLiveEdge/LEVEL_LOADED/FRAG_BUFFERED
// machinery this file used to carry - none of it has an equivalent need
// for a plain continuous connection).
//
// Wired to the remote's own play/pause state (see updateState() in
// player.js) rather than a separate control, so it mirrors Spotify's
// actual playback automatically.

const audio = document.getElementById("hlsAudio");
const marker = document.getElementById("hlsPositionMarker");

let currentlyStreaming = false;
let unlocked = false;

// Chrome blocks audio.play() unless it follows a real user gesture on
// this page load - call this once from the remote's own play/pause
// click handler, which already is one, so the automatic syncing below
// is allowed to call play() itself afterwards
export function unlockHlsAudio() {
    unlocked = true;
}

export function syncHlsToPlaybackState(playing) {

    // freeze the green marker's displayed position while paused
    markerFrozen = !playing;

    if (!unlocked) return;

    if (playing) resumeStream();
    else pauseStream();

}

// Called on every /state poll while playing (not just on the actual
// pause->play transition), so this has to be a no-op once already
// streaming - rebuilding on every single poll would tear the stream
// down and restart it from scratch every ~2s.
function resumeStream() {

    if (currentlyStreaming) return;

    // Fresh src every resume, not just audio.play() on a stale element -
    // the server spawns a genuinely new encoder/connection endpoint on
    // every real resume (see ensureEncoderRunning in server.js), so
    // there's nothing meaningful left on the old connection to resume
    // from even if the browser kept it open.
    audio.src = "/audio/stream.aac";
    audio.play();
    currentlyStreaming = true;

}

// Called on every poll while paused too, not just the transition.
function pauseStream() {

    if (!currentlyStreaming) return;

    audio.pause();
    // Explicitly drops the connection rather than just pausing playback -
    // matches the native app's own player.stop()-on-pause (see
    // PlaybackService.applyLocalPlaying), and avoids leaving a live
    // network connection open against an encoder the server is about to
    // kill anyway (server.js's own endAllAudioClients() would force it
    // closed regardless, but there's no reason for this side to hold it
    // open in the meantime).
    audio.removeAttribute("src");
    audio.load();
    currentlyStreaming = false;

}

// ---------------------------------------------------------------------
// Green marker: where on the track the audio actually audible right
// now corresponds to. Built as a delayed clone of the white seekbar,
// not an independently-reconstructed position - whatever the white bar
// did IS the truth (it comes straight from Spotify's own state), so
// just keep the last few samples of it and show the oldest one still
// kept.
//
// The lag is a fixed ~8s (measured by hand: pressing "previous" and
// timing until the restarted title is actually heard, 7-8s,
// consistent with the theoretical ~9s from the segment/sync-margin
// settings) rather than dynamically measured - it's set by our own
// fixed encoder/hls.js settings, so it doesn't drift and there's
// nothing to calibrate at runtime. Since the white bar only actually
// changes value once per /state poll (2s), "8s ago" is just "4 polls
// ago" - a small fixed-size queue, no timestamps needed.
//
// NOT re-measured for the continuous-broadcast redesign - the native
// app's own equivalent constant (AUDIO_BUFFERING_DISPLAY_MS in
// NowPlayingViewModel.kt) came down from 8000ms to ~4000ms under the new
// pipeline, so this fixed 8s lookback is very likely too long now too.
// Left as-is since this file is a legacy/unmaintained fallback, not
// actively used day-to-day - re-measure by hand the same way if it
// turns out to matter in practice.
// ---------------------------------------------------------------------

const HISTORY_LOOKBACK_ITERATIONS = 4; // 4 * 2s poll interval = 8s

let positionHistory = []; // FIFO of recent {position, duration}, oldest first
let markerFrozen = false;

// Called from player.js's updateState() with Spotify's own reported
// position, every poll.
export function recordSpotifyPosition(position, duration) {

    positionHistory.push({ position, duration });
    if (positionHistory.length > HISTORY_LOOKBACK_ITERATIONS + 1) positionHistory.shift();

    updateMarkerPosition();

}

const THUMB_WIDTH_PX = 3;

function updateMarkerPosition() {

    // holds whatever it was last showing - see syncHlsToPlaybackState
    if (markerFrozen) return;

    if (positionHistory.length <= HISTORY_LOOKBACK_ITERATIONS) {
        marker.style.display = "none"; // not enough history yet
        return;
    }

    const sample = positionHistory[0]; // oldest kept = 8s back

    if (!sample.duration) {
        marker.style.display = "none";
        return;
    }

    const fraction = Math.max(0, Math.min(1, sample.position / sample.duration));

    // a plain "fraction * 100%" doesn't match where the native seekbar
    // thumb actually sits: browsers inset its travel range by half its
    // own width at each end, so it never overlaps the track's edges
    marker.style.left =
        "calc(" + (THUMB_WIDTH_PX / 2) + "px + " + fraction + " * (100% - " + THUMB_WIDTH_PX + "px))";
    marker.style.display = "block";

}
