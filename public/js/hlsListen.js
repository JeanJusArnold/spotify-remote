// Temporary test module - not a finished feature. Validates whether a
// browser tab (hls.js, since Chrome has no native HLS support in
// <audio>) playing the DIY HLS stream from server.js can survive
// screen-off/backgrounded use well enough to be a viable AudioRelay
// replacement, before committing to building a native Android app.
//
// Wired to the remote's own play/pause state (see updateState() in
// player.js) rather than a separate control, so it mirrors Spotify's
// actual playback automatically.

const audio = document.getElementById("hlsAudio");
const marker = document.getElementById("hlsPositionMarker");

let hls = null;
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
// streaming - rebuilding hls.js on every single poll tore the stream
// down and restarted it from scratch every ~2s, which sounded like
// short loops of audio repeating before jumping to the next bit.
function resumeStream() {

    if (currentlyStreaming) return;

    if (hls || audio.src) {
        // already set up from earlier - the server just un-suspends the
        // same encoder (SIGCONT) rather than restarting it, so there's
        // nothing to rebuild, just resume playback
        if (audio.paused) audio.play();
        currentlyStreaming = true;
        return;
    }

    startStream();

}

// A real pause (not muting, not tearing anything down) - the server
// just suspends the encoder (SIGSTOP) rather than stopping it, so the
// stream this instance is attached to is still the same one and there's
// nothing to rebuild on resume.
function pauseStream() {

    // same reasoning as resumeStream - called on every poll while
    // paused, not just on the transition
    if (!currentlyStreaming) return;

    audio.pause();
    currentlyStreaming = false;

}

// Called from player.js's updateState() whenever the server reports a
// new audioReadyGeneration - it bumps that once it has confirmed (via
// waitForAudioSignal against the PC's real audio sink) that the new
// track has actually started producing sound, which is what "caught up"
// has to mean: jumping to hls.js's own live edge the instant a title
// change is merely noticed lands inside the still-silent gap the
// encoder captures during the real switch just as often as it lands on
// real audio, since the phone-visible title change and the PC's actual
// transition don't line up. Detecting that on the phone itself doesn't
// help either - whatever the phone hears is itself several seconds
// stale, so by the time it detects silence the real transition is long
// over. The server checking its own source is the only place this can
// be measured correctly.
// hls.liveSyncPosition (its own internal notion of "the edge minus a
// safety margin") turned out unreliable mid-session - it dropped to
// near 0 at least once with a session that had long since buffered far
// past that, jumping playback onto a position long since evicted from
// the actual live window (delete_segments) and producing silence with
// no way to recover short of a reload. audio.buffered is ground truth
// (exactly what's actually been fetched, hls.js internals aside), so
// anchoring to its own reported edge can't ever jump outside real data
// - worst case it undershoots, which is silent-but-harmless, never
// silent-and-broken.
const LIVE_EDGE_SAFETY_MARGIN_SECONDS = 1;

export function skipToLiveEdge() {
    if (!audio.buffered.length) return;
    const liveEdge = audio.buffered.end(audio.buffered.length - 1);
    audio.currentTime = Math.max(0, liveEdge - LIVE_EDGE_SAFETY_MARGIN_SECONDS);
}

function startStream() {

    if (window.Hls && window.Hls.isSupported()) {

        // default targets 3 segments (~18s at our 6s segment length)
        // behind live as a safety margin - too slow to start for real
        // use, so this trims it to 1 segment (~6s) instead. Less margin
        // against a delivery hiccup causing a stall, but the encoder's
        // cadence has been stable in testing
        //
        // backBufferLength defaults to Infinity - confirmed live: with
        // that default, audio.buffered's start never advances past
        // wherever this session first attached, only its end keeps
        // growing, holding onto every already-played second in memory
        // for the whole session even though nothing here ever seeks
        // backward (skipToLiveEdge only ever jumps forward). 30s is far
        // more than the ~6s segment / ~1 segment sync margin actually in
        // play, just enough slack that trimming can't ever compete with
        // playback for the same data.
        hls = new window.Hls({ liveSyncDurationCount: 1, backBufferLength: 30 });
        hls.loadSource("/hls/stream.m3u8");
        hls.attachMedia(audio);

        hls.on(window.Hls.Events.MANIFEST_PARSED, () => audio.play());

        // hls.js's own "start near live edge" logic on a fresh attach
        // shares the same liveSyncPosition calculation already known to
        // be unreliable (see skipToLiveEdge's own comment above) -
        // confirmed here too: playback started stuck at position 0
        // while audio.buffered only covered data far past that, with
        // nothing ever reachable at the stuck position.
        //
        // Jumping on the very first FRAG_BUFFERED isn't right either -
        // confirmed live: hls.js's own fetch order started from the
        // oldest segment still listed in the playlist, not the newest,
        // so the first buffered fragment lands nowhere near live. Only
        // once every fragment from the initial playlist load has been
        // buffered is audio.buffered.end() actually close to live -
        // LEVEL_LOADED's fragment count (captured once, from the first
        // playlist load only - later live-playlist refreshes fire it
        // again with a shifted window, not relevant here) says how many
        // to wait for.
        let initialFragmentCount = null;
        let fragmentsBuffered = 0;
        let skippedToLive = false;

        hls.on(window.Hls.Events.LEVEL_LOADED, (event, data) => {
            if (initialFragmentCount === null) initialFragmentCount = data.details.fragments.length;
        });

        hls.on(window.Hls.Events.FRAG_BUFFERED, () => {
            if (skippedToLive || initialFragmentCount === null) return;
            fragmentsBuffered++;
            if (fragmentsBuffered >= initialFragmentCount) {
                skippedToLive = true;
                skipToLiveEdge();
            }
        });

        hls.on(window.Hls.Events.ERROR, (event, data) => {
            console.log("hls.js error:", data);
        });

    } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari/iOS - native HLS support, no hls.js needed
        audio.src = "/hls/stream.m3u8";
        audio.play();
    }

    currentlyStreaming = true;

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
