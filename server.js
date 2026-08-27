const express = require("express");
const { chromium } = require("playwright");
const { execFile, spawn } = require("child_process");
const util = require("util");
const fs = require("fs");
const { WebSocketServer, WebSocket } = require("ws");

const execFileAsync = util.promisify(execFile);

const app = express();
const path = require("path");

app.use(express.static(path.join(__dirname, "public")));

const PORT = 3000;

// HTTPS (via a `tailscale cert`-issued cert for this machine's MagicDNS
// name) used to be required here for the old PWA client's
// installability (a secure context is mandatory for that) - now that
// the native Android app (see [[native_app_migration]]) is the only
// client, that requirement is gone: the app talks plain HTTP, over the
// Tailscale (WireGuard) tunnel that's already encrypted at that layer
// regardless of what this app-layer scheme is. Dropping TLS here is
// also what makes pasting a bare Tailscale IP (no MagicDNS hostname,
// which the old cert was only ever valid for) actually work - a cert
// tied to one specific hostname can never validate against an IP.

// DIY audio relay: captures the same virtual sink Chromium/Spotify play
// through and rebroadcasts it live to any connected client - continuous
// raw ADTS-AAC bytes over a single long-lived HTTP connection per
// listener (Icecast/SHOUTcast-style), no manifest, no segments.
//
// Replaced a segmented-HLS design on 2026-08-19 (see
// [[continuous_audio_relay_redesign]]): measured live against a real
// continuous webradio stream (VLC/Icecast) under matching network
// conditions, the segmented approach saved no mobile-radio power at all
// (LTE/5G's own ~10-15s RRC tail timer never let the radio actually
// sleep between our 4s segment/manifest polls) and cost ~3x more phone
// CPU (per-segment container parsing + manifest refetch + live-edge
// speed convergence), for no offsetting benefit in this single-client,
// LAN-via-Tailscale use case.

// Single, persistent sink - Chromium/Spotify's audio output routes
// straight into it (see [[pipewire_chromium_routing_drift]]). Never
// switched or touched by this project; see the encoder-rotation design
// below for why that's no longer needed.
//
// The encoder used to also rotate at every track transition (two
// dedicated sinks, alternating, switched via pw-link at the detected
// title-change moment) - abandoned 2026-08-15. Two real problems, not
// one: (1) the title text is not a reliable proxy for the true audio
// boundary - Spotify's crossfade/gapless timing means the title can
// settle before OR after real audio actually changes, so cutting the
// outgoing instance off at the detected moment sometimes truncated the
// new track's own first notes, confirmed live as reported "silence,
// sometimes just a cut, sometimes I don't hear the very first notes at
// all". (2) even a perfectly-timed cut would land IN THE MUSIC, not in
// a genuine gap - Spotify's transitions are usually gapless/crossfaded,
// so there generally isn't a quiet moment near a title change to exploit
// either. See [[dual_instance_hls_handoff]] for that whole
// investigation's history.
//
// The actual redesign: rotation is now tied to pause/resume instead of
// track transitions - see pauseSpotifyAndEncoder/resumeHlsEncoder. Since
// those are actions this server itself initiates (both the MPRIS command
// AND the encoder's own state), there's no title-lag/detection-race to
// fight at all - full control over both sides of the synchronization.
// Track transitions now get NO intervention whatsoever: the single
// active instance just keeps recording Chromium's raw output straight
// through, gapless/crossfaded/hard-cut, whatever Spotify actually does -
// which was never the source of the original glitch in the first place
// (that traced back to the OLD client's live-edge SEEKING landing badly
// in an otherwise-fine continuous stream, not to the raw content itself
// - see [[precise_segment_live_edge_seek]]).
const HLS_SINK = "spotify-remote-audio";

// Starting the encoder on a fixed guessed delay after telling Spotify
// to play was unreliable - Chromium's own audio pipeline startup isn't
// instant and its real latency varies, so a fixed delay either caught a
// beat of silence (too short) or added needless lag (too long). This
// instead probes the actual sink with a short ffmpeg volumedetect pass
// and only starts the encoder once real signal is measured. Confirmed
// thresholds on this system: true silence measures -91dB, real
// playback -19dB - -45dB sits with a lot of margin on both sides. Only
// used at boot (see startEncoderOnceAudioIsReal) - a regular /play
// commands Spotify itself, so it doesn't need to probe for signal that
// it's about to cause anyway, see resumeHlsEncoder.
const AUDIO_SIGNAL_THRESHOLD_DB = -45;
const AUDIO_SIGNAL_PROBE_SECONDS = 0.15;
const AUDIO_SIGNAL_POLL_INTERVAL_MS = 150;
// safety net in case Spotify never actually starts producing sound
// (track failed to load, etc.) - don't leave the encoder waiting forever
const AUDIO_SIGNAL_WAIT_TIMEOUT_MS = 4000;

function probeHasAudioSignal() {
    return new Promise((resolve) => {
        execFile("ffmpeg", [
            "-f", "pulse", "-i", `${HLS_SINK}.monitor`,
            "-t", String(AUDIO_SIGNAL_PROBE_SECONDS),
            "-af", "volumedetect",
            "-f", "null", "-"
        ], (error, stdout, stderr) => {
            const match = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
            resolve(!!match && parseFloat(match[1]) > AUDIO_SIGNAL_THRESHOLD_DB);
        });
    });
}

async function waitForAudioSignal() {
    const start = Date.now();
    while (Date.now() - start < AUDIO_SIGNAL_WAIT_TIMEOUT_MS) {
        if (await probeHasAudioSignal()) return;
        await new Promise(r => setTimeout(r, AUDIO_SIGNAL_POLL_INTERVAL_MS));
    }
}

// Every currently-connected /audio/stream.aac HTTP response - the
// broadcast set. One shared continuous byte stream (Icecast/SHOUTcast-
// style): no manifest, no segments, no per-client encoding. A client can
// sit in this set with nothing yet written to it (connected while
// paused - see the route handler's own comment) or actively receive
// live ADTS-AAC bytes as ffmpeg produces them.
const audioClients = new Set();

// Bounds a single slow/stalled client's memory growth without stalling
// broadcast to every OTHER client. res.write() itself never blocks the
// event loop - Node queues each response's outgoing bytes independently
// in its own per-socket buffer - so the risk isn't "the loop stalls,"
// it's "one dead client's queue grows forever." ~24s of 128kbps audio -
// generous enough to ride out a transient hiccup, small enough that a
// genuinely stuck client (screen off + bad radio handoff, app killed
// without a clean close, etc.) gets dropped well before it could leak
// meaningfully.
const MAX_CLIENT_BUFFERED_BYTES = 384 * 1024;

// Called from pauseSpotifyAndEncoder right where the encoder is
// SIGKILLed - gives every connected client a clean EOF instead of a
// silently-hanging connection. Android's own player.stop() (driven by
// the same pause event over /state-stream) usually gets there first,
// but this is a cheap, correct backstop that also covers the legacy web
// <audio> client, which has no equivalent teardown of its own.
function endAllAudioClients() {
    for (const res of audioClients) {
        try { res.end(); } catch { /* already closing */ }
    }
    audioClients.clear();
}

// Continuous ADTS-AAC broadcast - Icecast/SHOUTcast-style: one
// long-lived connection per listener, raw encoded bytes, no manifest.
// Headers are sent (and flushed) immediately on connect regardless of
// whether an encoder is currently running: a listener joining while
// paused just holds the connection open with nothing written yet,
// exactly like an Icecast listener joining an idle mount point - the
// next resume's broadcast loop (see spawnEncoderInstance) starts
// writing to this same res the moment it exists, since it's already in
// audioClients.
app.get("/audio/stream.aac", (req, res) => {

    res.writeHead(200, {
        "Content-Type": "audio/aac",
        "Cache-Control": "no-store",
        "Connection": "keep-alive"
    });
    res.flushHeaders();

    audioClients.add(res);
    req.on("close", () => audioClients.delete(res));

});

// Spotify's own real reaction latency to a Pause command - measured live
// via [pause-timing]/[silence] instrumentation, order ~100-150ms for
// Spotify itself plus D-Bus round-trip overhead, ~400ms all in. Used by
// pauseSpotifyAndEncoder to wait for that real audio to actually stop
// before killing the encoder, instead of cutting it off mid-sound.
const PAUSE_REACTION_LEAD_MS = 400;

// spawn() children aren't tied to the parent's lifetime - killing this
// node process (even just Ctrl-C) left ffmpeg running orphaned in the
// background, and every restart piled up another one, all fighting over
// the same output directory (confirmed: found 4 running at once after a
// few restarts, explaining garbled/out-of-order segments). Make sure it
// actually dies with us, on any of the ways this process can end - see
// stopAllEncoderInstances/process.on below.
//
// Only ever one of these alive at a time now - pause fully kills the
// current instance (after a couple of clean segment boundaries, see
// pauseSpotifyAndEncoder) rather than freezing it, and resume always
// spawns a genuinely fresh one (see resumeHlsEncoder), never
// overlapping. Each generation still gets its own incrementing id, used
// for its filename prefix (see spawnEncoderInstance), so append_list
// keeps extending the SAME manifest across a pause/resume cycle instead
// of the client seeing the stream restart from scratch.
let encoderGeneration = 0;
let currentInstance = null;

function spawnEncoderInstance(sinkName) {

    const generation = ++encoderGeneration;

    const ffmpeg = spawn("ffmpeg", [
        "-f", "pulse", "-i", `${sinkName}.monitor`,
        // silenceremove: every fresh instance's capture starts a beat
        // before Spotify's real audio does (MPRIS Play has to travel and
        // Spotify itself needs a moment to actually resume producing
        // sound) - measured live via the silencedetect probe below at a
        // stable ~100-150ms of true digital silence at the very start of
        // every resume, consistent across multiple real pause/resume
        // cycles. Stripping it here (start_periods=1, one shot, only at
        // the very beginning of the stream) means that dead air is never
        // encoded at all, instead of landing in the manifest where a
        // client resuming near the live edge would otherwise sit right
        // on top of it. -50dB/20ms is deliberately tight - true silence
        // sits far below that floor, so a genuinely quiet track intro
        // isn't at real risk of being eaten.
        //
        // (an afade right after silenceremove was tried here 2026-08-16 to
        // smooth what looked like a splice click, but the user confirmed
        // the actual complaint was real content loss on the PAUSE side -
        // a click fix was solving the wrong problem, removed 2026-08-17)
        //
        // Deliberately NOT using stop_periods/stop_duration/stop_threshold
        // to also trim the trailing residual on the pause side. Tried
        // live, in this always-running instance: in positive mode this
        // filter engages on the FIRST silence period it ever sees and
        // never lets go, including an ordinary quiet passage in the
        // middle of a track being listened to normally - froze the whole
        // encoder mid-track, unrelated to any real pause. Also tried
        // offline, as a one-shot post-process on the already-closed final
        // segment file (worked technically - stop_periods is safe there,
        // the input is a genuinely finite file) - reverted a second time
        // 2026-08-17, the user's own listening judgment being that the
        // resulting shorter-but-abrupt cut felt LESS natural than the
        // plain lead-time residual left below. Don't re-add either
        // version without a specific request.
        //
        // silencedetect: chained last so it observes the already-cleaned
        // signal - a pass-through analysis filter that doesn't alter the
        // audio, purely instrumentation to confirm (via the [silence]
        // server logs) that no leading silence remains, and more
        // generally to get a REAL ground-truth timestamp for when
        // captured audio goes silent/resumes, instead of inferring it
        // from MPRIS ack timing alone.
        "-af", "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-50dB,silencedetect=n=-50dB:d=0.05",
        // 128k matches, not wastes: the Spotify Web Player itself caps
        // streaming quality around 128kbps regardless of account tier -
        // unlike native apps, it has no "Très élevée"/~320kbps option -
        // so encoding above that here would just be re-inflating an
        // already-capped source, not preserving extra fidelity
        "-acodec", "aac", "-b:a", "128k",
        // Raw ADTS-AAC elementary stream to stdout - no container, no
        // manifest. Each ADTS frame carries its own header, so a client
        // joining mid-stream (every listener, by construction - see
        // /audio/stream.aac's own comment) can lock onto the next frame
        // boundary on its own, the same way any Icecast/SHOUTcast AAC
        // player already handles a mid-broadcast join.
        "-f", "adts", "pipe:1"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const log = fs.createWriteStream(path.join(__dirname, "hls-encoder.log"), { flags: "a" });
    ffmpeg.stderr.pipe(log);

    // Resolves once ffmpeg's own stderr confirms it has actually opened
    // the pulse input (registered as a client, ready to consume samples
    // the instant they arrive) - resumeHlsEncoder awaits this before
    // ever telling Spotify to actually play, guaranteeing something is
    // always there to capture from the very first real sample (no
    // late-arriving-reader gap, since this project itself controls both
    // sides of that timing now - see resumeHlsEncoder's own comment).
    let resolveInputReady;
    const inputReady = new Promise((resolve) => { resolveInputReady = resolve; });
    let stderrSoFar = "";
    const inputReadyListener = (chunk) => {
        if (!resolveInputReady) return;
        stderrSoFar += chunk.toString();
        if (stderrSoFar.includes("Input #0, pulse, from")) {
            resolveInputReady();
            resolveInputReady = null;
        }
    };
    ffmpeg.stderr.on("data", inputReadyListener);

    // Ground-truth silence timing for pause/resume micro-gap analysis -
    // see the silencedetect filter above. Logged separately from the
    // ffmpeg.log file (which just captures raw stderr) so these events
    // are easy to grep for and to cross-reference by wall-clock time
    // against the [pause-timing]/[resume-timing] logs in
    // pauseSpotifyAndEncoder/resumeHlsEncoder.
    let silenceCarry = "";
    const silenceListener = (chunk) => {
        silenceCarry += chunk.toString();
        const lines = silenceCarry.split("\n");
        silenceCarry = lines.pop(); // last (possibly partial) line held for next chunk
        for (const line of lines) {
            const startMatch = line.match(/silence_start:\s*([\d.]+)/);
            if (startMatch) console.log(`[silence] gen=${generation} silence_start pts=${startMatch[1]}s wallclock=${Date.now()}`);
            const endMatch = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
            if (endMatch) console.log(`[silence] gen=${generation} silence_end pts=${endMatch[1]}s duration=${endMatch[2]}s wallclock=${Date.now()}`);
        }
    };
    ffmpeg.stderr.on("data", silenceListener);

    // The actual broadcast: every raw ADTS byte ffmpeg produces goes to
    // every currently-connected client, unmodified, as soon as it
    // arrives. See MAX_CLIENT_BUFFERED_BYTES's own comment for how a
    // slow client is isolated from the others instead of stalling this
    // loop.
    ffmpeg.stdout.on("data", (chunk) => {
        for (const res of audioClients) {
            if (res.writableLength > MAX_CLIENT_BUFFERED_BYTES) {
                audioClients.delete(res);
                res.destroy();
                continue;
            }
            res.write(chunk);
        }
    });

    const instance = { generation, sinkName, process: ffmpeg, exited: false, inputReady };

    ffmpeg.on("exit", (code, signal) => {
        instance.exited = true;
        console.error(`HLS encoder gen=${generation} exited (code=${code}, signal=${signal})`);
        // safety net - if ffmpeg died before ever opening its input,
        // don't leave resumeHlsEncoder waiting on a promise that can
        // never resolve
        if (resolveInputReady) resolveInputReady();
    });

    return instance;

}

// safety net for spawnEncoderInstance's inputReady - normally resolves
// in well under a second; this only kicks in if ffmpeg is somehow
// unusually slow to even open its input, so it can be generous
const ENCODER_INPUT_READY_TIMEOUT_MS = 5000;

function waitForEncoderInputReady(instance) {
    return Promise.race([
        instance.inputReady,
        new Promise((resolve) => setTimeout(resolve, ENCODER_INPUT_READY_TIMEOUT_MS))
    ]);
}

// Only for a genuinely fresh pipeline start (boot, or nothing alive to
// resume from - see resumeHlsEncoder) - starts the very first instance.
function startFreshHlsPipeline() {
    currentInstance = spawnEncoderInstance(HLS_SINK);
}

// Only used at boot - see HLS_SINK's own comment for why a regular
// resume doesn't need this
async function startEncoderOnceAudioIsReal() {
    await waitForAudioSignal();
    startFreshHlsPipeline();
}

function stopAllEncoderInstances() {
    // SIGTERM (kill()'s default) is queued, not acted on, by a process
    // currently stopped via SIGSTOP - could still happen to be true for
    // an instance mid-shutdown some other way, so keep using SIGKILL,
    // which works unconditionally regardless of stop state.
    if (currentInstance && !currentInstance.exited) currentInstance.process.kill("SIGKILL");
}

// /state must still report the user's actual intent right away, or a
// client keeps seeing "still playing" for the whole delay below and
// never updates the icon. null = no override, report Spotify's real
// aria-label as-is.
let pendingPlayingIntent = null;

// WebSocket clients connected to /state-stream (see its own comment
// near the WebSocketServer setup) - pushed to directly instead of each
// client having to poll /state on its own schedule.
const wsClients = new Set();

// Compared against on every push to decide whether anything actually
// changed - position deliberately excluded (see pushStateIfChanged's
// own comment for why), so this only reflects title/artist/playing/
// duration/cover/shuffle/repeat.
let lastPushedDedupJson = null;

// position/playing/wall-clock-time at the last actual push - used only
// to detect a backward jump (see pushStateIfChanged below), not part of
// the dedup comparison itself. Tracking the timestamp and playing flag
// alongside the position (not just the raw position) matters: pushes can
// be minutes apart when nothing dedup-worthy happens, so the raw
// last-pushed position alone goes stale almost immediately once playback
// keeps ticking past it - comparing a fresh scrape against that stale
// number made a real restart-to-0 look like it landed *above*, not
// below, an old near-zero baseline from whenever the track started.
let lastPushedPositionSeconds = null;
let lastPushedPositionAtMs = null;
let lastPushedWasPlaying = false;

function parsePositionSeconds(text) {
    const [minutes, seconds] = text.split(":").map(Number);
    if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
    return minutes * 60 + seconds;
}

// Re-scrapes and pushes the current state to every connected client,
// but only if it actually changed since the last push, EXCLUDING
// position from that comparison - confirmed live: Spotify's own
// position text ticks every second, which the DOM observer below picks
// up as a real mutation just as readily as an actual title change,
// and without this exclusion that meant a push every ~1s regardless of
// whether anything a client would care about actually changed, no
// better than the polling this whole thing replaced. Position still
// rides along in the payload itself (clients need a starting point),
// it just isn't what decides whether to send one - clients extrapolate
// position locally between real pushes instead.
//
// A backward jump in position is the one exception that still forces a
// push even with every dedup field unchanged - confirmed live: /previous
// restarting the current track (Spotify/MPRIS's own standard "restart if
// more than a few seconds in" behavior, not something this app
// implements itself) changes only position, nothing else, so the dedup
// check alone would silently swallow it and leave clients extrapolating
// forward from the stale pre-restart position forever. Compared against
// the *expected* current position (last pushed position + real elapsed
// time since, while playing) rather than the raw last-pushed position -
// otherwise, since real pushes can be minutes apart, a fresh scrape
// naturally ends up far ahead of a long-stale last-pushed number even
// with nothing anomalous going on, which either misses a real restart
// (if the restart lands above the stale baseline) or false-positives on
// every single push (if compared carelessly the other way). Real
// playback position only ever matches its own expected value between
// pushes, so a meaningful shortfall (tolerance for scrape-timing noise,
// not a real threshold) is unambiguous.
async function pushStateIfChanged() {
    // scrapeState (and anything downstream of it here) can throw if
    // Chromium's page navigates mid-scrape (its execution context gets
    // destroyed) - confirmed live 2026-08-19: an unhandled rejection from
    // exactly this path (server.log: "Execution context was destroyed,
    // most likely because of a navigation", inside scrapeState, called
    // from here) crashed the entire Node process, taking the whole
    // server down over a single transient page navigation. None of this
    // function's callers await/catch it (by design - they don't want a
    // slow scrape to block the route handler that triggered it), so this
    // is the one shared place that needs to swallow the error: skip this
    // push, the next real DOM mutation or state-changing action fires
    // another attempt anyway.
    try {
        const state = applyPendingIntent(await scrapeState());
        const { position, ...dedupFields } = state;
        const dedupJson = JSON.stringify(dedupFields);
        const positionSeconds = parsePositionSeconds(position);
        let wentBackward = false;
        if (lastPushedPositionSeconds !== null && positionSeconds !== null) {
            const elapsedSeconds = lastPushedWasPlaying
                ? (Date.now() - lastPushedPositionAtMs) / 1000
                : 0;
            const expectedPositionSeconds = lastPushedPositionSeconds + elapsedSeconds;
            wentBackward = positionSeconds < expectedPositionSeconds - 2;
        }
        if (dedupJson === lastPushedDedupJson && !wentBackward) return;
        lastPushedDedupJson = dedupJson;
        lastPushedPositionSeconds = positionSeconds;
        lastPushedPositionAtMs = Date.now();
        lastPushedWasPlaying = state.playing;
        const json = JSON.stringify(state);
        for (const client of wsClients) {
            if (client.readyState === WebSocket.OPEN) client.send(json);
        }
    } catch (err) {
        console.error("[pushStateIfChanged] skipped a push after an error:", err.message);
    }
}

// Bumped by every /play and /pause call, and snapshotted by
// pauseSpotifyAndEncoder()/resumeHlsEncoder() below at the start of
// their waits - if a play lands while a pause is still waiting out its
// segment margin (or vice versa), this changes out from under the
// stale one, letting it tell it's been superseded and back off instead
// of acting on a tap that's no longer the user's actual intent.
let actionGeneration = 0;

// Real, server-enforced protection - replaces the old design where the
// CLIENT predicted a timing window (shieldMs/pauseLandsInMs) during
// which a conflicting tap was dangerous, and just hoped its own guess
// matched the server's real timing closely enough (see
// [[segment_boundary_tracking_fixed]] for how far off that guess could
// actually be). Now the server itself sets this true for the exact
// duration a real MPRIS-triggering command would risk corrupting an
// in-flight resumeHlsEncoder/pauseSpotifyAndEncoder, and every route
// wrapped in requiresMprisUnblocked (below) rejects outright (409) if a
// request lands while it's set. Exposed to clients via /state and the
// state-stream WebSocket push (mprisBlocked field) so the UI can mirror
// real server state directly instead of running its own predictive
// timer.
let mprisBlocked = false;

// Every route that calls ensureEncoderRunning()/mprisCommand() needs
// this - confirmed via grep 2026-08-18 that's exactly /play, /pause,
// /next, /previous, /play-result, /queue-play, no others (checked
// deliberately after almost missing /play-result and /queue-play, which
// share the exact same "make Spotify produce audio with no encoder
// ready to capture it" failure mode as /next/previous but were easy to
// overlook since they don't look like transport controls). A shared
// wrapper instead of repeating the same `if (mprisBlocked)` check at
// each call site, to keep it consistent - if a NEW route starts calling
// either of those two functions, it needs this wrapper too.
function requiresMprisUnblocked(handler) {
    return async (req, res) => {
        if (mprisBlocked) return res.status(409).json({ ok: false, error: "mpris_blocked" });
        return handler(req, res);
    };
}

// Simplified 2026-08-19 for the continuous-broadcast redesign (see
// [[continuous_audio_relay_redesign]]): no more segment-boundary
// alignment to wait for - there's no manifest to keep consistent, so
// pause can commit essentially immediately instead of the old 3-wait
// segment-aligned sequence (finish in-flight segment / optional margin
// segment / lead-time wait). mprisBlocked is now set right away too, so
// unlike the old multi-second deferred-pause window, there's no
// meaningful gap left for a competing /play to race into - the 409
// reject at the route layer already closes that from the very start
// (see requiresMprisUnblocked). PAUSE_REACTION_LEAD_MS is reused as-is:
// it represents Spotify's own real pause-reaction latency, unchanged by
// this redesign - only what it's no longer being aligned against does.
async function pauseSpotifyAndEncoder() {

    const encoderToStop = currentInstance;

    mprisBlocked = true;
    pushStateIfChanged();

    try {

        let ok = await mprisCommand("Pause");
        console.log(`[pause-timing] MPRIS Pause acked at ${Date.now()}`);
        if (!ok) {
            const alreadyPlaying = (await controls.playPause.getAttribute("aria-label")) === "Pause";
            if (alreadyPlaying) await controls.playPause.click({ noWaitAfter: true });
        }

        // Give Spotify's real audio time to actually stop before cutting
        // the encoder - same measured reaction lag as before, just no
        // longer waiting for a segment boundary on top of it.
        await new Promise((r) => setTimeout(r, PAUSE_REACTION_LEAD_MS));

        if (encoderToStop && !encoderToStop.exited) encoderToStop.process.kill("SIGKILL");
        console.log(`[pause-timing] ffmpeg gen=${encoderToStop?.generation} killed at ${Date.now()}`);
        if (currentInstance === encoderToStop) currentInstance = null;
        endAllAudioClients();

        // Not re-pushed here on purpose - confirmed live this was a real
        // race: pendingPlayingIntent clearing right as the real MPRIS pause
        // command goes out, before Spotify's own aria-label has necessarily
        // caught up yet, meant scrapeState() could momentarily read the
        // still-stale "Pause" label and push a spurious playing:true that
        // self-corrected ~300ms later once the DOM observer caught the real
        // change. /pause's own route handler already pushed the false
        // intent the instant it was set; nothing here actually changed from
        // a client's perspective, so there's nothing that needs pushing
        // again - the DOM observer picks up Spotify's own real confirmation
        // on its own once it actually happens.
        pendingPlayingIntent = null;
        selfHealTowards(false);

    } finally {
        mprisBlocked = false;
        pushStateIfChanged();
    }

}

// Shared by resumeHlsEncoder and /next /previous below - all three need
// "make sure something is capturing before Spotify might start making
// sound", they just differ in which MPRIS command actually unblocks
// that sound. No-op if an instance is already running - either
// playback never actually stopped (a pending pause got superseded) or
// there's simply nothing to spawn for. Otherwise, spawns fresh and
// waits for it to actually be consuming (inputReady) before returning -
// same ordering as the spawn-before-link fix this project already hit
// once (see [[dual_instance_hls_handoff]]), applied here to whichever
// command is about to make Spotify produce real audio again.
async function ensureEncoderRunning() {

    if (currentInstance && !currentInstance.exited) return;

    const incoming = spawnEncoderInstance(HLS_SINK);
    currentInstance = incoming;

    await waitForEncoderInputReady(incoming);

}

async function resumeHlsEncoder() {

    // Whole-function block - see mprisBlocked's own comment for why: no
    // cancellation guard exists here (a /pause landing mid-wait still
    // results in Play being sent regardless once ready), so the entire
    // window is dangerous, not just its tail.
    mprisBlocked = true;
    pushStateIfChanged();

    try {

        await ensureEncoderRunning();

        // Micro-gap timing instrumentation - cross-reference against the
        // [silence] logs from this (possibly just-spawned) instance's own
        // silencedetect filter to see how long after the input-ready/MPRIS
        // round trip real audio actually starts flowing again.
        const resumeGen = currentInstance ? currentInstance.generation : null;
        console.log(`[resume-timing] encoder input ready at ${Date.now()} (gen=${resumeGen})`);

        // sent unconditionally, even if nothing needed spawning above (i.e.
        // Spotify was already genuinely playing) - MPRIS Play is a no-op on
        // an already-playing player, confirmed live, so there's no need to
        // track "did we actually need to do anything" separately
        let ok = await mprisCommand("Play");
        console.log(`[resume-timing] MPRIS Play acked at ${Date.now()} (gen=${resumeGen})`);
        if (!ok) {
            const alreadyPlaying = (await controls.playPause.getAttribute("aria-label")) === "Pause";
            if (!alreadyPlaying) await controls.playPause.click({ noWaitAfter: true });
        }

        selfHealTowards(true);

    } finally {
        mprisBlocked = false;
        pushStateIfChanged();
    }

}

process.on("exit", stopAllEncoderInstances);
process.on("SIGINT", () => { stopAllEncoderInstances(); process.exit(); });
process.on("SIGTERM", () => { stopAllEncoderInstances(); process.exit(); });

let page;
let cdpSession;
let controls = {};

// the initial /playlist batch, kept so /playlist-more can pick up where
// it left off without re-scraping it - relevant now that /playlist
// pre-positions the scrollbar past this batch before responding
let lastPlaylistInitialTracks = [];

const FOLDER_ICON = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="%23888" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';

async function waitForStableCount(locator, { checks = 3, interval = 400, timeout = 8000 } = {}) {

    const start = Date.now();
    let lastCount = -1;
    let stableChecks = 0;

    while (Date.now() - start < timeout) {

        const count = await locator.count();

        if (count === lastCount) {
            stableChecks++;
            if (stableChecks >= checks) return count;
        } else {
            stableChecks = 0;
            lastCount = count;
        }

        await new Promise(r => setTimeout(r, interval));
    }

    return lastCount;
}

// Same stability-polling shape as waitForStableCount above, but for
// cases where the row COUNT alone can't tell a stale render from a
// fresh one - the queue panel's rows update in place (same element
// count before and after a track change), so only comparing their
// actual content catches Spotify's own React re-render still being in
// flight. Same generous default budget as waitForStableCount (still
// exits early the moment 3 reads in a row agree, usually within one or
// two intervals) rather than a shorter one - the one confirmed live
// report of this race was the very FIRST track played in a freshly
// booted session, where Spotify likely has more to bootstrap (its own
// queue/connect-state service, not just this one row's re-render) than
// a mid-session track change - no reason to assume that always finishes
// as fast as the warm-session case this was tuned against.
async function waitForStableValue(getValue, { checks = 3, interval = 400, timeout = 8000 } = {}) {

    const start = Date.now();
    let last = null;
    let stableChecks = 0;
    let current = await getValue();

    while (Date.now() - start < timeout) {

        const key = JSON.stringify(current);

        if (key === last) {
            stableChecks++;
            if (stableChecks >= checks) return current;
        } else {
            stableChecks = 0;
            last = key;
        }

        await new Promise(r => setTimeout(r, interval));
        current = await getValue();
    }

    return current;
}

async function clickDiscographyChip(chipLabel) {

    return await evaluateAndClick((label) => {

        const shelves = [...document.querySelectorAll('[data-testid="component-shelf"]')];

        const discoShelf = shelves.find(s =>
            s.querySelector('[data-testid="rich-title-row-shelf-header"]')?.innerText.startsWith('Discographie')
        );

        if (!discoShelf) return null;

        const chip = [...discoShelf.querySelectorAll('[data-encore-id="chip"]')]
            .find(c => c.innerText === label);

        return chip || null;

    }, chipLabel);

}

async function scrapeDiscographyCards() {

    return await page.evaluate(() => {

        const shelves = [...document.querySelectorAll('[data-testid="component-shelf"]')];

        const discoShelf = shelves.find(s =>
            s.querySelector('[data-testid="rich-title-row-shelf-header"]')?.innerText.startsWith('Discographie')
        );

        const cards = [...discoShelf.querySelectorAll('[data-encore-id="card"]')];

        return cards.map(card => {

            const labelledBy = card.getAttribute('aria-labelledby') || "";
            const uriMatch = labelledBy.match(/spotify:(album|track):([a-zA-Z0-9]+)/);

            if (!uriMatch) return null;

            const titleEl = card.querySelector('[id^="card-title-"]');
            const subtitleEl = card.querySelector('[id^="card-subtitle-"]');
            const cover = card.querySelector('[data-testid="card-image"]')?.src || "";

            return {
                id: uriMatch[2],
                type: uriMatch[1],
                title: titleEl?.innerText || "",
                subtitle: subtitleEl?.innerText || "",
                cover
            };

        }).filter(Boolean);

    });

}

// transport commands go straight to Chromium's MPRIS interface over
// D-Bus instead of clicking DOM buttons through Playwright - Playwright
// is kept only for reading info and for actions with no MPRIS
// equivalent (opening the queue panel, browsing, etc.)
let mprisService = null;

async function findMprisService() {

    if (mprisService) return mprisService;

    const { stdout } = await execFileAsync("gdbus", [
        "call", "--session",
        "--dest", "org.freedesktop.DBus",
        "--object-path", "/org/freedesktop/DBus",
        "--method", "org.freedesktop.DBus.ListNames"
    ]);

    const match = stdout.match(/'(org\.mpris\.MediaPlayer2\.chromium\.[^']+)'/);

    mprisService = match ? match[1] : null;

    return mprisService;

}

async function mprisCommand(method) {

    const service = await findMprisService();

    if (!service) return false;

    try {

        await execFileAsync("gdbus", [
            "call", "--session",
            "--dest", service,
            "--object-path", "/org/mpris/MediaPlayer2",
            "--method", "org.mpris.MediaPlayer2.Player." + method
        ]);

        return true;

    } catch (e) {
        // chromium likely restarted under a new instance id - force
        // rediscovery on the next command
        mprisService = null;
        return false;
    }

}

async function connectSpotify() {
    const browser = await chromium.connectOverCDP(
        "http://127.0.0.1:9222"
    );

    const contexts = browser.contexts();
    const pages = contexts.flatMap(c => c.pages());

    // other tabs (e.g. left open from a browser-based `gh auth login`)
    // can outnumber or come before the Spotify one, so pick it out by
    // URL instead of assuming it's contexts[0].pages()[0]
    page = pages.find(p => p.url().includes("open.spotify.com")) || pages[0];

    // Confirmed live 2026-08-27: the state-push MutationObserver (see
    // injectStateObserver) went silently dead mid-session - a real DOM
    // change (shuffle toggle) happened, /state read it correctly, but
    // zero /state-stream clients got pushed, surfacing to the user as
    // "the PC plays fine but the app stops following" (exactly the
    // failure mode injectStateObserver's own comment already warned
    // about). The two explicit reinstall call sites only cover
    // navigations THIS code itself triggers (page.goto/page.reload) -
    // a real navigation from outside that code (e.g. a manual F5 at
    // the physical keyboard, used to recover from an anti-bot
    // lockdown per README) replaces the document just the same but
    // was never being caught. page.on("load") fires on every real
    // navigation regardless of what triggered it, so this closes that
    // gap generically instead of chasing every possible trigger.
    page.on("load", () => {
        injectStateObserver().catch(e =>
            console.error("[state-observer] reinject after load failed:", e.message));
    });

    cdpSession = await page.context().newCDPSession(page);

    console.log("Connected to Spotify:", await page.title());

    // keep references to the buttons
    controls.shuffle =
        page.locator('[data-testid="general-controls"] button').first();

    controls.repeat =
        page.getByTestId("control-button-repeat");

    controls.playPause =
        page.getByTestId("control-button-playpause");

    controls.next =
        page.getByTestId("control-button-skip-forward");

    controls.previous =
        page.getByTestId("control-button-skip-back");

    console.log("Spotify controls loaded");


}


// ---------------------------------------------------------------------
// Known personal quirks
//
// Workarounds for issues specific to this account's own Spotify content,
// not the app's logic.
// ---------------------------------------------------------------------

// on this account, some Spotify-side content (confirmed so far: one
// specific playlist, and separately "Titres likés") flips the whole web
// player to Arabic (sp_locale cookie set to "ar" by Spotify's own
// backend) as soon as it's opened - not something we can prevent, and
// not worth tracking down every id that triggers it, so this checks for
// it after every playlist load instead and silently fixes it whenever it
// happens
async function fixArabicLocaleBug() {
    await page.context().addCookies([{
        name: "sp_locale",
        value: "fr",
        domain: ".spotify.com",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 5,
        httpOnly: false,
        secure: true,
        sameSite: "None"
    }]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await injectStateObserver();
}

// the "ar" cookie doesn't always land the instant a playlist opens - it
// can show up a moment later, so a single check right after navigation
// isn't enough. Poll for a few seconds, and if it flips, fix it and watch
// again (the fix's own re-navigation can retrigger the same bug)
async function ensureFrenchLocale(id) {

    for (let attempt = 0; attempt < 2; attempt++) {

        let flipped = false;

        for (let i = 0; i < 6; i++) {
            const lang = await page.evaluate(() => document.documentElement.lang);
            if (lang !== "fr") { flipped = true; break; }
            await page.waitForTimeout(500);
        }

        if (!flipped) return;

        await fixArabicLocaleBug();
        await tryClickAnywhere(id);
        await page.waitForSelector('[data-testid="tracklist-row"]', { timeout: 8000 });

    }

}


// gdbus can report success on a stale/idle MPRIS interface without any
// real effect - confirmed case: after the minimal session sits idle for
// a while, waking it (mouse/keyboard) leaves MPRIS commands acknowledged
// but silently no-op until a real click happens once. Catching that
// needs checking the button's state again a moment later, but the
// happy path (the vast majority of calls) is near-instant - so that
// check runs in the background *after* responding, instead of holding
// up every single call for it. A real, working MPRIS call has been
// observed to land in well under 100ms.
const SELF_HEAL_DELAY_MS = 100;

// /play and /pause are the only entry points now - both the remote's
// own button and Chrome's media notification (see setupMediaSession in
// player.js) call whichever one matches their own last-known state
// directly, rather than a single toggle route guessing direction from
// Spotify's own aria-label. That guess used to be wrong whenever a
// pause was still waiting to land (see pauseSpotifyAndEncoder above) -
// Spotify's real button can keep saying "Pause" (= currently playing)
// for a few seconds after the tap, so a quick second tap meant as
// "resume" got misread as "pause" again.
//
// Explicit, non-toggling commands also just suit a client that already
// knows the state it wants better than a toggle would - blindly
// flipping would risk acting on a state that's since moved on, whereas
// calling the wrong one of these two just does nothing.
function selfHealTowards(targetIsPlaying) {
    setTimeout(async () => {
        try {
            const isPlaying = (await controls.playPause.getAttribute("aria-label")) === "Pause";
            if (isPlaying !== targetIsPlaying) await controls.playPause.click({ noWaitAfter: true });
        } catch (e) { /* page navigated away or similar - nothing to heal */ }
    }, SELF_HEAL_DELAY_MS);
}

// Client-predicted shield timing (shieldMs/pauseLandsInMs) is gone -
// mprisBlocked (see its own comment) is now the real, server-enforced
// mechanism; the client just mirrors that boolean instead of running its
// own timer. requiresMprisUnblocked rejects outright (409) if this
// lands while mprisBlocked is true - a real backstop, not the primary
// mechanism (the client's own UI is expected to prevent the tap from
// ever reaching here in the first place).
app.get("/play", requiresMprisUnblocked(async (req, res) => {

    actionGeneration++;
    pendingPlayingIntent = null;
    pushStateIfChanged();

    res.json({ ok: true });

    resumeHlsEncoder();
}));

app.get("/pause", requiresMprisUnblocked(async (req, res) => {

    actionGeneration++;
    pendingPlayingIntent = false;
    pushStateIfChanged();

    // Near-trivial now that there's no segment-alignment wait sequence
    // left to mirror - pauseSpotifyAndEncoder's only real wait is
    // PAUSE_REACTION_LEAD_MS itself. Still only consumed client-side for
    // NowPlayingViewModel's position-extrapolation display deadline
    // (pauseDeadlineElapsedMs), same as before.
    res.json({ ok: true, pauseLandsInMs: PAUSE_REACTION_LEAD_MS });
    pauseSpotifyAndEncoder();

}));

// Confirmed live (2026-08-15): Spotify auto-resumes on Next/Previous
// even from a fully paused state (MPRIS PlaybackStatus flips straight
// to Playing) - it doesn't just change track and stay paused like a
// typical media player would. Two consequences, both fixed here:
// (1) ensureEncoderRunning must run BEFORE the real MPRIS command,
// same spawn-before-audio-flows ordering as resumeHlsEncoder, or the
// new track's audio has nowhere to go at all - confirmed live: real
// Spotify audio playing, zero ffmpeg process, phone stuck silent until
// a manual /play rescued it. (2) actionGeneration/pendingPlayingIntent
// are reset the same way /play does it, since a still-pending deferred
// pause must not land after this - without it, tapping Next during a
// pause's wait let the pause fire anyway a few seconds later and cut
// the new track right back off, and /state kept reporting paused
// forever after (pauseSpotifyAndEncoder only resets
// pendingPlayingIntent on the branch that reaches the end of its own
// wait, which a cancelled-via-actionGeneration early return skips).
// Everything below actionGeneration++ can throw (stale page/controls
// after a Chromium crash, ensureEncoderRunning's ffmpeg spawn, etc.) -
// unlike /play, this used to await the whole chain before ever calling
// res.send(), so a throw here left the request hanging forever with no
// response at all (confirmed live via server.log: "Target page, context
// or browser has been closed" from a stale page after a Chromium crash,
// with no res.send() ever reached). Wrapped so the client always gets a
// response - a real error surfaces as a fast 500 instead of a silent
// timeout.
app.get("/next", requiresMprisUnblocked(async (req, res) => {
    actionGeneration++;
    pendingPlayingIntent = null;
    try {
        await ensureEncoderRunning();
        pushStateIfChanged();
        let ok = await mprisCommand("Next");
        if (!ok) ok = await controls.next.click({ noWaitAfter: true }).then(() => true);
        res.send(ok ? "ok" : "mpris unavailable");
        selfHealTowards(true);
    } catch (e) {
        console.error("/next failed:", e.message);
        res.status(500).send("error");
    }
}));


// same reasoning as /next above
app.get("/previous", requiresMprisUnblocked(async (req, res) => {
    actionGeneration++;
    pendingPlayingIntent = null;
    try {
        await ensureEncoderRunning();
        pushStateIfChanged();
        let ok = await mprisCommand("Previous");
        if (!ok) ok = await controls.previous.click({ noWaitAfter: true }).then(() => true);
        res.send(ok ? "ok" : "mpris unavailable");
        selfHealTowards(true);
    } catch (e) {
        console.error("/previous failed:", e.message);
        res.status(500).send("error");
    }
}));


app.get("/shuffle", async (req, res) => {

    // Toggling shuffle re-shuffles the "À suivre" queue on Spotify's own
    // backend, not instantly - confirmed live it can take ~700-1000ms
    // after the click for the panel's row order to actually change. The
    // Android client refreshes its queue view right after this responds
    // (same trigger used for queue-add), so responding too early is the
    // same class of race as [[queue_add_refresh_race]]: the client's
    // refresh would land before the reorder and show the stale,
    // pre-shuffle order. Only directly observable while the queue panel
    // is already open on the PC; when it isn't, there's nothing to poll,
    // so just wait out the same real-world delay instead of a guess with
    // no grounding.
    const rowsBefore = await page.evaluate(() => {
        const list = document.querySelector('ul[aria-label="À suivre"]');
        if (!list) return null;
        return [...list.querySelectorAll('li[role="row"]')].slice(0, 3).map(row =>
            row.querySelector('[id^="listrow-title-"]')?.innerText || ""
        );
    });

    await controls.shuffle.click({
        noWaitAfter: true
    });

    if (rowsBefore) {
        await page.waitForFunction(
            (rowsBefore) => {
                const list = document.querySelector('ul[aria-label="À suivre"]');
                if (!list) return true;
                const rowsNow = [...list.querySelectorAll('li[role="row"]')].slice(0, 3).map(row =>
                    row.querySelector('[id^="listrow-title-"]')?.innerText || ""
                );
                return JSON.stringify(rowsNow) !== JSON.stringify(rowsBefore);
            },
            rowsBefore,
            { timeout: 3000 }
        ).catch(() => {});
    } else {
        await page.waitForTimeout(1200);
    }

    res.send("ok");
});


app.get("/repeat", async (req, res) => {
    await controls.repeat.click({
        noWaitAfter: true
    });
    res.send("ok");
});

// the now-playing bar's context link always points to the track's
// album, even when playing from a playlist/radio/etc.; the queue
// panel's own heading ("À suivre dans : X") names the real context.
// Reading either this or the queue list itself requires the panel to
// be open, so both are read together here, only called when the
// client detects the track has actually changed (not on a fixed poll),
// rather than on every /state request. Left open afterwards rather
// than restored to closed - flipping it open/closed on every track
// change is more visually disruptive on the actual desktop screen
// than just leaving it open once opened
async function getContextAndQueue() {

    // the panel being open is what matters, not specifically the
    // algorithmic "À suivre" list - confirmed live: queuing a whole
    // album via the Web Player's own "Ajouter à la file d'attente"
    // (instead of one track at a time through this app) leaves the
    // panel showing ONLY the manual list, no algorithmic continuation
    // at all. The old code waited on the algo list alone, so that real,
    // reachable state made every /context-and-queue call hang for a
    // full 8s and then 500 - checking/waiting for either list fixes
    // that without weakening anything for the normal case.
    const panelAlreadyOpen = await page.evaluate(() =>
        !!document.querySelector('ul[aria-label="À suivre"]') ||
        !!document.querySelector('ul[aria-label="À suivre dans la file d\'attente"]')
    );

    if (!panelAlreadyOpen) {
        await page.getByTestId("control-button-queue").click();
        await Promise.race([
            page.waitForSelector('ul[aria-label="À suivre"]', { timeout: 8000 }),
            page.waitForSelector('ul[aria-label="À suivre dans la file d\'attente"]', { timeout: 8000 })
        ]).catch(() => {});
    }

    const scrape = () => page.evaluate(() => {

        function scrapeRows(list) {

            if (!list) return [];

            const rows = [...list.querySelectorAll('li[role="row"]')];

            return rows.map(row => {

                const titleEl = row.querySelector('[id^="listrow-title-"]');
                const subtitleEl = row.querySelector('[id^="listrow-subtitle-"]');
                const cover = row.querySelector('img')?.src || "";

                const artistLinks = [...(subtitleEl?.querySelectorAll('a') || [])];
                const subtitle = artistLinks.length
                    ? artistLinks.map(a => a.innerText).join(", ")
                    : (subtitleEl?.innerText || "");

                return { title: titleEl?.innerText || "", subtitle, cover };

            });

        }

        const list = document.querySelector('ul[aria-label="À suivre"]');

        // manually-queued tracks ("Ajouter à la file d'attente") live in
        // their own separate list, distinct from this algorithmic
        // continuation - both are read together since both need the
        // panel open anyway. Neither is guaranteed to exist on its own
        // (see above), so this no longer bails out just because the
        // algorithmic one specifically is missing.
        const manualList = document.querySelector('ul[aria-label="À suivre dans la file d\'attente"]');

        if (!list && !manualList) return { context: "", queue: [], manualQueue: [] };

        const headingText = list?.previousElementSibling?.innerText || "";
        const match = headingText.match(/:\s*(.+)/);
        const context = match ? match[1].trim() : "";

        return {
            context,
            queue: scrapeRows(list),
            manualQueue: scrapeRows(manualList)
        };

    });

    // The panel's <ul> mounting (waited for above) doesn't mean its ROWS
    // already reflect the current track - Spotify re-renders existing
    // row elements in place rather than remounting them on a context
    // change, so the very first scrape right after a track change can
    // still read the previous context's queue. Confirmed live: title
    // updates immediately (separate DOM node, separate observer path -
    // see injectStateObserver), but this panel visibly lags behind it by
    // up to roughly a second, worse right after a fresh Chromium/session
    // start. Poll until two consecutive reads agree instead of trusting
    // the first one.
    return await waitForStableValue(scrape);

}

// Shared by /state (kept for compatibility/debugging - the app itself
// moved to the /state-stream WebSocket push below) and the push path
// itself - both need the exact same scrape, not two copies of it.
async function scrapeState() {

    return await page.evaluate(() => {

        const playButton =
            document.querySelector(
                '[data-testid="control-button-playpause"]'
            );


        const title =
            document.querySelector(
                '[data-testid="context-item-info-title"]'
            )?.innerText || "";

        const artist =
            document.querySelector(
                '[data-testid="context-item-info-artist"]'
            )?.innerText || "";


        const position =
            document.querySelector(
                '[data-testid="playback-position"]'
            )?.innerText || "";

        const duration =
            document.querySelector(
                '[data-testid="playback-duration"]'
            )?.innerText || "";

        const cover =
            (document.querySelector(
                '[data-testid="cover-art-button"] img'
            )?.src || "").replace("ab67616d00004851", "ab67616d0000b273");

        const shuffleButton =
            document.querySelector(
                '[data-testid="general-controls"] button'
            );

        // no aria-checked/aria-pressed exposed on this button (unlike repeat
        // below), so state has to be read from Spotify's own "active" color
        // class instead of the language-dependent aria-label text
        const shuffle =
            shuffleButton?.classList.contains("encore-internal-color-text-bright-accent") || false;

        // The button actually cycles through 3 states on click: off ->
        // classic shuffle -> "smart" shuffle (mixes in similar tracks not
        // in the original context) -> off again - confirmed live via CDP.
        // Both shuffle states share the same active color class above, so
        // they're indistinguishable from that alone; the aria-label text
        // (what clicking the button would DO next, not the current state)
        // is the only DOM signal that tells them apart: "Activer ...
        // intelligente" means classic is currently active (next click
        // would turn smart ON), "Désactiver ... intelligente" means smart
        // is currently active (next click turns everything off). Same
        // French-aria-label-parsing precedent as the library follow-state
        // scrape elsewhere in this file - fine for a single-account
        // personal system.
        const smartShuffle =
            shuffle && (shuffleButton?.getAttribute("aria-label") || "").startsWith("Désactiver");

        const repeatChecked =
            document.querySelector(
                '[data-testid="control-button-repeat"]'
            )?.getAttribute("aria-checked");

        let repeat = "off";
        if (repeatChecked === "true") repeat = "context";
        else if (repeatChecked === "mixed") repeat = "track";

        return {
            title,
            artist,
            playing:
                playButton?.getAttribute("aria-label") === "Pause",
            position,
            duration,
            cover,
            shuffle,
            smartShuffle,
            repeat
        };

    });

}

// reflect the not-yet-real-on-Spotify pause intent immediately (see
// pendingPlayingIntent) rather than Spotify's own current aria-label -
// otherwise a client sees "still playing" for the whole delay
// pauseSpotifyAndEncoder waits out, and never mutes/updates the icon.
// Also layers in mprisBlocked (see its own comment) - same idea, a
// server-known truth the DOM scrape itself has no way to reflect.
function applyPendingIntent(state) {
    if (pendingPlayingIntent !== null) state.playing = pendingPlayingIntent;
    state.mprisBlocked = mprisBlocked;
    return state;
}

app.get("/state", async (req, res) => {
    res.json(applyPendingIntent(await scrapeState()));

});

app.get("/search", async (req, res) => {

    const query = req.query.q;

    if (!query) {
        return res.status(400).send("missing q");
    }

    try {

        const searchInput = page.getByTestId("search-input");

        await searchInput.click();
        await searchInput.fill(query);
        await page.keyboard.press("Enter");

        await page.waitForSelector('[data-testid="title"]', { timeout: 8000 });
        await waitForStableCount(page.locator('[data-testid="title"]'));

        const results = await page.evaluate(() => {

            const titleEls = [...document.querySelectorAll('[data-testid="title"]')];

            return titleEls.map(t => {

                const href = t.querySelector('a[href]')?.getAttribute('href');
                const match = href?.match(/\/(artist|album|track|playlist)\/([a-zA-Z0-9]+)/);

                if (!match) return null;

                let subtitleEl = null;
                let ancestor = t.parentElement;
                for (let d = 0; d < 4 && ancestor && !subtitleEl; d++) {
                    subtitleEl = ancestor.querySelector('[data-testid="subtitle"]');
                    ancestor = ancestor.parentElement;
                }

                let cover = "";
                let imgAncestor = t.parentElement;
                for (let d = 0; d < 5 && imgAncestor && !cover; d++) {
                    cover = imgAncestor.querySelector('img')?.src || "";
                    imgAncestor = imgAncestor.parentElement;
                }

                return {
                    id: match[2],
                    type: match[1],
                    title: t.innerText,
                    subtitle: subtitleEl?.innerText || "",
                    cover
                };

            }).filter(Boolean);

        });

        res.json(results);

    } catch (e) {
        console.error(e);
        res.status(500).send("search error");
    }

});

function scrapeWhatsNewRows() {

    return page.evaluate(() => {

        const rows = [...document.querySelectorAll(
            '[data-testid="infinite-scroll-list"] li[role="row"]'
        )];

        return rows.map(row => {

            const titleLink = row.querySelector('[data-encore-id="listRowTitle"] a[href]');
            if (!titleLink) return null;

            const href = titleLink.getAttribute('href');
            const match = href.match(/\/(artist|album|track|playlist)\/([a-zA-Z0-9]+)/);

            if (!match) return null;

            const subtitleEl = row.querySelector('[data-encore-id="listRowSubtitle"]');
            const artists = subtitleEl?.innerText || "";

            // "__bottom" (BEM suffix, tolerant of the hashed class
            // prefix changing across Spotify deploys - same trick as
            // [class*="YourLibraryX"] elsewhere) holds the release type
            // ("Single"/"Album") and a relative date ("il y a 2 jours")
            // that's sometimes in weeks/months instead - both nested
            // together with no separator in the raw text, so split the
            // date out first and rejoin cleanly
            const bottomEl = row.querySelector('[class*="__bottom"]');
            let releaseInfo = "";
            if (bottomEl) {
                const dateText = bottomEl.querySelector('span > span')?.textContent.trim() || "";
                const typeText = bottomEl.textContent.replace(dateText, "").trim();
                releaseInfo = [typeText, dateText].filter(Boolean).join(" · ");
            }

            return {
                id: match[2],
                type: match[1],
                title: titleLink.innerText,
                subtitle: artists,
                meta: releaseInfo,
                cover: row.querySelector('img')?.src || ""
            };

        }).filter(Boolean).filter((item, index, all) => {
            // Confirmed live 2026-08-19: this feed can shift while
            // scrolling (a new release landing at the top mid-scrape, or
            // Spotify's own +10-per-scroll pagination overlapping by a
            // row) - real result was the same album's <li> appearing
            // twice in the DOM, same id, crashing the Android client's
            // LazyColumn (which requires unique keys). Keep the first
            // occurrence only.
            return all.findIndex((other) => other.id === item.id) === index;
        });

    });

}

// Unlike the library sidebar's virtualized rows, nothing here ever gets
// removed from the DOM once loaded - it's a plain paginated
// infinite-scroll: each real scroll near the bottom loads +10 more rows,
// up to a hard cap (observed 50, but not hardcoded here - just scroll
// until the count stops growing).
//
// Real keyboard PageDown presses on the feed's own `ul[role="treegrid"]`
// (focused via ElementHandle.focus() - a genuine CDP focus) instead of
// page.mouse.wheel() - the old uniform 3000px-every-500ms wheel scroll
// was suspected of being its own detectable automation signature,
// separate from the isTrusted click issue fixed elsewhere in this file
// (a continuous wheel gesture has a physical shape - acceleration,
// per-device delta, momentum - that's hard to fake convincingly; a
// PageDown keystroke is a discrete action with no such shape to get
// wrong). Confirmed live (2026-08-19, clean unblocked session) that
// PageDown does work here, but each press only moves the treegrid by
// a modest amount - the row count can plateau for 2-3 consecutive
// presses before crossing the next +10 threshold, unlike the old giant
// wheel jump which crossed a threshold almost every tick. So, same as
// scrollToFindAndClick's tracklist scan, termination is judged by
// scrollTop no longer moving (the real bottom), not by the row count
// happening to be unchanged on any single press - breaking on that
// would stop early, mid-list.
// the feed's first batch (10 rows) is already in the DOM as soon as the
// page itself is - no scrolling needed, unlike scrapeAllWhatsNewRows'
// remaining ~40 rows. Split out so /whats-new can return quickly
// instead of always paying the full multi-second scroll-scan up front.
async function waitForWhatsNewFeedReady() {
    const rowLocator = page.locator('[data-testid="infinite-scroll-list"] li[role="row"]');
    await rowLocator.first().waitFor({ timeout: 8000 });
    return rowLocator;
}

// same trick as positionTracklistAfterInitialBatch (playlists) - a
// plain scrollTop write, not a real scroll/wheel gesture, so it doesn't
// itself trigger Spotify's own lazy-load (confirmed elsewhere in this
// file: setting scrollTop directly never does). Jumps straight past the
// rows already sent in the first batch, so /whats-new-more's PageDown
// scan starts from there instead of re-covering ground already shown.
async function positionWhatsNewAfterInitialBatch(rowCount) {

    return await page.evaluate((rowCount) => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const row = document.querySelector('[data-testid="infinite-scroll-list"] li[role="row"]');
        const container = row ? findScrollable(row) : null;

        if (!container || !row) return false;

        const rowHeight = row.getBoundingClientRect().height;
        const totalRange = container.scrollHeight - container.clientHeight;

        container.scrollTop = Math.min(rowCount * rowHeight, totalRange);

        return true;

    }, rowCount);

}

async function scrapeAllWhatsNewRows() {

    await waitForWhatsNewFeedReady();

    await page.locator('ul[role="treegrid"]').first().focus().catch(() => {});

    const getScrollTop = () => page.evaluate(() => {
        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }
        const list = document.querySelector('[data-testid="infinite-scroll-list"]');
        const container = list ? findScrollable(list) : null;
        return container ? container.scrollTop : null;
    });

    let lastScrollTop = await getScrollTop();

    for (let i = 0; i < 40; i++) {

        await page.keyboard.press("PageDown");
        await page.waitForTimeout(400);

        const scrollTop = await getScrollTop();

        if (scrollTop === lastScrollTop) break;

        lastScrollTop = scrollTop;

    }

    return await scrapeWhatsNewRows();

}

// same "not in the DOM yet" problem as the artist discography grid and
// library sidebar, but scoped to the Nouveautés content feed - the app
// can cache a full 50-item scrape client-side and show it instantly on
// return instead of re-running scrapeAllWhatsNewRows (see /browser-back),
// but the real feed itself resets to just its first 10-row batch on a
// fresh visit, so a tap on anything beyond that isn't clickable yet.
// Self-guards on the missing list the same way the other two do -
// harmless to try even when the tap actually came from elsewhere.
async function scrollWhatsNewAndRetryClick(clickFn, direction) {

    const hasFeed = await page.evaluate(() => !!document.querySelector('[data-testid="infinite-scroll-list"]'));
    if (!hasFeed) return false;

    return pageStepUntilFound(async () => {
        return await page.locator('ul[role="treegrid"]').first().focus()
            .then(() => true).catch(() => false);
    }, clickFn, direction, async () => {
        return await page.evaluate(() => {
            function findScrollable(el) {
                while (el && el !== document.body) {
                    const style = getComputedStyle(el);
                    if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                        return el;
                    }
                    el = el.parentElement;
                }
                return null;
            }
            const list = document.querySelector('[data-testid="infinite-scroll-list"]');
            const container = list ? findScrollable(list) : null;
            return container ? container.scrollTop : null;
        });
    });

}

// "Nouveautés" - new releases from followed artists/podcasts. Same
// scraped shape as /search ({id, type, title, subtitle, cover}) so the
// existing result rendering/click-to-play on the client works unchanged.
// The "Musique" tab is Spotify's default here, so only album/track/
// artist/playlist links show up - podcast episodes (a separate tab)
// aren't covered yet, same as /search already only handles those types.
// Returns just the first batch (fast, no scrolling) rather than the
// full ~50-item scan - the client shows this immediately with a
// "Charger plus" button (see /whats-new-more) instead of blocking on
// the multi-second scroll-scan every single visit, per the user's
// request 2026-08-19.
app.get("/whats-new", async (req, res) => {

    try {

        // The button toggles the view - clicking it while already there
        // closes it and navigates back, so only click when needed
        if (!page.url().includes("/content-feed")) {
            await page.click('[data-testid="whats-new-feed-button"]');
        }

        await waitForWhatsNewFeedReady();

        const results = await scrapeWhatsNewRows();

        res.json(results);

        // purely prepares the next "Charger plus" call - the remote
        // already has its answer, this shouldn't delay it. Only bother
        // if there's plausibly more to reveal (a full batch came back);
        // response is already sent, so failures here are just logged.
        if (results.length >= 10) {
            try {
                await positionWhatsNewAfterInitialBatch(results.length);
            } catch (e) {
                console.error("positionWhatsNewAfterInitialBatch failed:", e);
            }
        }

    } catch (e) {
        console.error(e);
        res.status(500).send("whats-new error");
    }

});

// "Charger plus" - runs the full scroll-scan and returns everything,
// same one-shot "reveal the rest" shape as /playlist-more and
// /library-more (not true incremental paging - a single tap here gets
// the whole remaining list at once).
app.get("/whats-new-more", async (req, res) => {

    try {

        res.json(await scrapeAllWhatsNewRows());

    } catch (e) {
        console.error(e);
        res.status(500).send("whats-new-more error");
    }

});

async function tryClickPlayableElement(id) {

    // a shared link (see /resolve-link) sits the page directly on this
    // exact entity's own page rather than a row referencing it from
    // some list - there's nothing to find in that case, its own
    // action-bar "Lecture" button is the equivalent action. That button
    // is a combined play/pause toggle, and Spotify's own delayed
    // autoplay can land at just the wrong moment (confirmed live: a
    // click landed right as autoplay had already started the track,
    // toggling it straight back off) - verify once more afterward and
    // correct with the ordinary bottom-bar button, same self-heal shape
    // as selfHealTowards elsewhere.
    if (page.url().includes(`/${id}`)) {

        const clicked = await page.locator('[data-testid="action-bar-row"] [data-testid="play-button"]')
            .click({ timeout: 5000 }).then(() => true).catch(() => false);

        if (!clicked) return false;

        await new Promise(r => setTimeout(r, 1000));
        const isPlaying = (await controls.playPause.getAttribute("aria-label")) === "Pause";
        if (!isPlaying) await controls.playPause.click({ noWaitAfter: true });

        return true;

    }

    const rowAlreadyPlaying = await page.evaluate((id) => {

        const link = document.querySelector(`a[href*="/${id}"]`)
            || document.querySelector(`[aria-labelledby*="${id}"]`);

        if (!link) return false;

        let ancestor = link;

        for (let d = 0; d < 6 && ancestor; d++) {

            const buttons = [...ancestor.querySelectorAll('button')];

            // a Pause button this close to the link means this row IS
            // already the currently playing track; stop here instead of
            // climbing further and grabbing an unrelated row's button
            const pauseBtn = buttons.find(b =>
                b.getAttribute('aria-label')?.startsWith('Mettre en pause') ||
                b.getAttribute('aria-label') === 'Pause'
            );

            if (pauseBtn) return true;

            if (buttons.some(b =>
                b.getAttribute('data-testid') === 'play-button' ||
                b.getAttribute('aria-label')?.startsWith('Lire') ||
                b.getAttribute('aria-label') === 'Lecture'
            )) return false;

            ancestor = ancestor.parentElement;

        }

        return false;

    }, id);

    if (rowAlreadyPlaying) return true;

    return await evaluateAndClick((id) => {

        const link = document.querySelector(`a[href*="/${id}"]`)
            || document.querySelector(`[aria-labelledby*="${id}"]`);

        if (!link) return null;

        let ancestor = link;

        for (let d = 0; d < 6 && ancestor; d++) {

            const playBtn = [...ancestor.querySelectorAll('button')].find(b =>
                b.getAttribute('data-testid') === 'play-button' ||
                b.getAttribute('aria-label')?.startsWith('Lire') ||
                b.getAttribute('aria-label') === 'Lecture'
            );

            if (playBtn) return playBtn;

            ancestor = ancestor.parentElement;

        }

        return null;

    }, id);

}

// same row-widening walk-up as tryClickPlayableElement, but opens the
// "more options" menu and picks the queue entry instead of pressing
// play - the menu item has no stable testid/attribute, only its French
// label, same tradeoff as the other Spotify-rendered-text matches
// elsewhere in this file (see the README's language dependency note)
async function tryAddToQueue(id) {

    const opened = await evaluateAndClick((id) => {

        const link = document.querySelector(`a[href*="/${id}"]`)
            || document.querySelector(`[aria-labelledby*="${id}"]`);

        if (!link) return null;

        let ancestor = link;

        for (let d = 0; d < 6 && ancestor; d++) {

            const moreBtn = [...ancestor.querySelectorAll('button')].find(b =>
                b.getAttribute('data-testid') === 'more-button'
            );

            if (moreBtn) return moreBtn;

            ancestor = ancestor.parentElement;

        }

        return null;

    }, id);

    if (!opened) return false;

    await page.waitForSelector('[role="menu"]', { timeout: 3000 }).catch(() => {});

    // captured BEFORE the click, not after - the queue panel's own list
    // only exists in the DOM at all once it's been opened at least once
    // this session, and if it's currently closed there's nothing to
    // compare against below anyway (handled by the flat fallback delay)
    const manualQueueCountBefore = await page.evaluate(() =>
        document.querySelector('ul[aria-label="À suivre dans la file d\'attente"]')
            ?.querySelectorAll('li[role="row"]').length ?? null
    );

    const clicked = await evaluateAndClick(() => {

        const menu = document.querySelector('[role="menu"]');
        if (!menu) return null;

        const item = [...menu.querySelectorAll('[role="menuitem"]')].find(i =>
            i.innerText.trim() === "Ajouter à la file d'attente"
        );

        return item || null;

    });

    // don't leave a stray open menu behind if the item wasn't found
    // (e.g. this row turned out not to be a track)
    if (!clicked) {
        await page.keyboard.press("Escape").catch(() => {});
        return false;
    }

    // Spotify's own click handler updates the queue panel asynchronously
    // - confirmed live: responding "ok" right after the click (as this
    // used to) let the client's own immediate refresh (QueueRefreshTrigger,
    // see NowPlayingViewModel) race ahead of it and read the queue panel
    // BEFORE the new row had actually rendered, showing every add as
    // "missing" until the next unrelated refresh (a track change)
    // happened to catch it later. If the panel was already open, wait
    // for its own row count to actually increase; if it wasn't open at
    // all, there's no DOM signal to watch, so just give Spotify's UI a
    // moment before answering.
    if (manualQueueCountBefore === null) {
        await page.waitForTimeout(500);
    } else {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            const count = await page.evaluate(() =>
                document.querySelector('ul[aria-label="À suivre dans la file d\'attente"]')
                    ?.querySelectorAll('li[role="row"]').length ?? 0
            );
            if (count > manualQueueCountBefore) break;
            await page.waitForTimeout(150);
        }
    }

    return true;

}

async function scrollTracklistToTop() {

    await page.evaluate(() => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const row = document.querySelector('[data-testid="tracklist-row"]');
        const container = row ? findScrollable(row) : null;

        if (container) container.scrollTop = 0;

    });

}

async function scrollTracklistToFraction(fraction) {

    return await page.evaluate((fraction) => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const row = document.querySelector('[data-testid="tracklist-row"]');
        const container = row ? findScrollable(row) : null;

        if (!container) return false;

        const totalRange = container.scrollHeight - container.clientHeight;
        container.scrollTop = totalRange * fraction;

        return true;

    }, fraction);

}

// right after the initial batch is shown, pre-position the scrollbar so
// the next unseen row is already the first one visible - if "Charger
// plus" gets tapped later, the forward PageDown scan can start from here
// instead of re-covering the rows already sent in the first batch
async function positionTracklistAfterInitialBatch(rowCount) {

    return await page.evaluate((rowCount) => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const row = document.querySelector('[data-testid="tracklist-row"]');
        const container = row ? findScrollable(row) : null;

        if (!container || !row) return false;

        const rowHeight = row.getBoundingClientRect().height;
        const totalRange = container.scrollHeight - container.clientHeight;

        container.scrollTop = Math.min(rowCount * rowHeight, totalRange);

        return true;

    }, rowCount);

}

// steps through a virtualized list with real PageUp/PageDown key
// presses, checking for the target after every press so the scan
// stops the moment it's found - shared by every "the tap missed a
// virtualized-out target" search fallback (tracklist/library
// sidebar/discography grid), which only differ in how the list gets
// keyboard focus
async function pageStepUntilFound(focusFn, clickFn, direction, getScrollTop) {

    if (await clickFn()) return true;

    if (!(await focusFn())) return false;

    const key = direction === "up" ? "PageUp" : "PageDown";
    const maxPresses = 40;

    let lastScrollTop = await getScrollTop();

    for (let i = 0; i < maxPresses; i++) {

        await page.keyboard.press(key);
        await page.waitForTimeout(350);

        if (await clickFn()) return true;

        // hit the top/bottom of the list - nothing further to reveal
        const scrollTop = await getScrollTop();
        if (scrollTop === lastScrollTop) break;
        lastScrollTop = scrollTop;

    }

    return false;

}

// Simulates the mouse "back" (thumb) button most mice have, via a raw
// CDP Input.dispatchMouseEvent (button: "back") rather than Playwright's
// page.goBack()/reload() history APIs - those are programmatic
// navigation calls, not real input, and page.reload() specifically was
// confirmed live 2026-08-19 to trigger a much more severe Spotify
// anti-automation lockdown than any click. A back-button mouse click is
// real trusted input the same way page.mouse.click() is, using
// browser-native back-navigation semantics instead of a CDP navigation
// primitive - the user's own suggestion after the reload incident.
// Coordinates don't matter (this isn't a click on page content), just
// need to be inside the viewport.
async function browserBackClick() {
    await cdpSession.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: 10, y: 10, button: "back", buttons: 8, clickCount: 1
    });
    await cdpSession.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: 10, y: 10, button: "back", buttons: 0, clickCount: 1
    });
}

// Real CDP-dispatched click (isTrusted: true) at an element's center -
// confirmed live 2026-08-19 that Spotify flags/restricts the session
// after enough JS-synthetic (isTrusted: false) clicks (repeat/shuffle
// got disabled, new tracks stopped playing; a real mouse click
// recovered it instantly). Deliberately skips Playwright's full
// actionability engine (visibility/stability polling, hit-test) for
// latency, keeping only scrollIntoViewIfNeeded - confirmed live that
// boundingBox()/isVisible() alone are NOT enough: a row further down a
// tall list still reports a "visible" non-zero box even when it's
// below the actual viewport (e.g. y=1180 against a 992px-tall window),
// so page.mouse.click() at that box silently clicked empty page space
// (elementFromPoint at those coordinates returned nothing). If a
// specific call site also needs the hit-test (risk of clicking
// whatever else is topmost at these coordinates), switch that site to
// a full ElementHandle.click() instead - see scrollToFindAndClick's
// focusFn for the existing example.
async function clickHandle(handle) {
    await handle.scrollIntoViewIfNeeded().catch(() => {});
    const box = await handle.boundingBox();
    if (!box) return false;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return true;
}

// page.evaluateHandle + clickHandle + dispose, bundled - the find-and-
// click callback returns the target element (or null/undefined)
// instead of clicking it itself, mirroring every existing
// page.evaluate(...) callback's shape almost exactly (swap
// `el.click(); return true` for `return el`).
async function evaluateAndClick(fn, ...args) {
    const handle = await page.evaluateHandle(fn, ...args);
    const el = handle.asElement();
    if (!el) { await handle.dispose(); return false; }
    const clicked = await clickHandle(el);
    await handle.dispose();
    return clicked;
}

// the client already knows roughly where the tapped track sits
// relative to the center position "Charger plus" leaves the cursor
// at, so it tells us which way to look. Clicking the column header
// row gives real keyboard focus without risking triggering playback,
// same trick as the "Charger plus" scan. clickFn is pluggable (play,
// add to queue, ...) - only what happens once the row is found differs
async function scrollToFindAndClick(clickFn, direction) {

    return pageStepUntilFound(async () => {

        const headerHandle = await page.evaluateHandle(() => {

            function findScrollable(el) {
                while (el && el !== document.body) {
                    const style = getComputedStyle(el);
                    if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                        return el;
                    }
                    el = el.parentElement;
                }
                return null;
            }

            const row = document.querySelector('[data-testid="tracklist-row"]');
            const container = row ? findScrollable(row) : null;

            return container ? container.querySelector('[role="row"]') : null;

        });

        const headerEl = headerHandle.asElement();
        const focused = !!headerEl;
        if (headerEl) await headerEl.click({ timeout: 3000 }).catch(() => {});
        await headerHandle.dispose();

        return focused;

    }, clickFn, direction, async () => {
        const info = await currentTracklistScrollInfo();
        return info ? info.scrollTop : null;
    });

}

// Same class of bug /next and /previous had (see their own comment):
// clicking a result's play button while paused makes Spotify start
// playing with no encoder running to capture it - silent audio on the
// phone until a manual /play - and leaves /state stuck reporting
// paused (pendingPlayingIntent never reset). ensureEncoderRunning()
// before the click, actionGeneration/pendingPlayingIntent reset the
// same way, fixes both.
app.get("/play-result", requiresMprisUnblocked(async (req, res) => {

    const id = req.query.id;
    const direction = req.query.direction === "up" ? "up" : "down";

    if (!id) {
        return res.status(400).send("missing id");
    }

    try {

        actionGeneration++;
        pendingPlayingIntent = null;
        await ensureEncoderRunning();

        let clicked = await tryClickPlayableElement(id);

        if (!clicked) {
            clicked = await scrollToFindAndClick(() => tryClickPlayableElement(id), direction);
        }

        if (!clicked) {
            clicked = await scrollWhatsNewAndRetryClick(() => tryClickPlayableElement(id), direction);
        }

        if (!clicked) {
            // Silent from the client's perspective otherwise: the
            // buffering overlay it shows on tap (AudioBufferingTrigger)
            // is a plain fixed-duration timer, not gated on confirming
            // this specific track actually started - so a 404 here reads
            // to the user as "nothing happened, or the wrong/previous
            // track kept playing", not as a clear error. Logging id and
            // the page's current URL/title makes a failed click here
            // diagnosable after the fact instead of only guessable.
            console.error(`[play-result] not found: id=${id} url=${page.url()} title=${await page.title().catch(() => "?")}`);
            return res.status(404).send("not found");
        }

        res.send("ok");

        // Deliberately NOT calling selfHealTowards() here, unlike /next
        // and /previous's own generic-resume case (/queue-play dropped
        // it too, see its own comment) - confirmed live 2026-08-26
        // (diagnostic logging, since removed) that it actively CAUSES
        // the exact bug it looks like it'd fix.
        // selfHealTowards exists for MPRIS commands whose acknowledgment
        // can be a stale no-op (see its own comment) - this route
        // doesn't use MPRIS at all, it's a real DOM click, which doesn't
        // have that failure mode. What it DOES have is a track SWITCH in
        // flight: right after the click, Spotify's player can still be
        // internally on the PREVIOUS track for up to ~1-2s (worse right
        // after a fresh Chromium/session boot) before it actually swaps
        // over. selfHealTowards' blind controls.playPause.click() during
        // that window doesn't "heal" anything - it toggles whatever
        // Spotify still has loaded, which is the previous track, and
        // that resumes IT instead. Confirmed live: tapped track visibly
        // started, then the previous (paused) track relaunched over it
        // a moment later - exactly this race.

    } catch (e) {
        console.error(e);
        res.status(500).send("play error");
    }

}));

app.get("/queue-add", async (req, res) => {

    const id = req.query.id;
    const direction = req.query.direction === "up" ? "up" : "down";

    if (!id) {
        return res.status(400).send("missing id");
    }

    try {

        let added = await tryAddToQueue(id);

        if (!added) {
            added = await scrollToFindAndClick(() => tryAddToQueue(id), direction);
        }

        if (!added) {
            return res.status(404).send("not found");
        }

        res.send("ok");

    } catch (e) {
        console.error(e);
        res.status(500).send("queue-add error");
    }

});

// Spotify links shared to the phone land here (see share_target in
// manifest.json) with the raw shared text - pull out whatever looks
// like a Spotify link/URI and resolve it into the same shape /search
// returns, so the client can show it in the search overlay as if it
// were a single search result. Playing/browsing only happens once the
// user actually taps it, through the exact same handlers a real search
// result already uses (see createResultItem in player.js) - this route
// itself never plays anything, EXCEPT that Spotify's own web player
// autoplays track pages on its own a second or so after navigating
// there, independent of anything this does - confirmed live, and
// confirmed live too that trying to fight it (catching the moment it
// starts and clicking pause) doesn't reliably stick, Spotify just
// re-asserts playing again. Album/playlist/artist pages never do this.
// So for tracks specifically this makes sure the encoder is at least
// running (see below) instead of pretending there's a silent "resolved
// but not yet playing" state to show - the client skips the overlay
// entirely for that type (see openSharedLink in player.js), since
// tapping a card for something already playing would hit the
// action-bar's toggle and pause it right back off.
const SPOTIFY_LINK_PATTERN =
    /open\.spotify\.com\/(?:intl-\w+\/)?(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)|spotify:(track|album|playlist|artist|episode|show):([a-zA-Z0-9]+)/;

app.get("/resolve-link", async (req, res) => {

    const raw = req.query.url || req.query.text || "";
    const match = raw.match(SPOTIFY_LINK_PATTERN);

    if (!match) {
        return res.status(400).send("no spotify link found");
    }

    const type = match[1] || match[3];
    const id = match[2] || match[4];

    try {

        // Spotify autoplaying the track is real playback, not just a
        // page load - confirmed live: if the encoder wasn't already
        // running (e.g. it was correctly left stopped at boot because
        // Spotify was paused then), that autoplay produces real sound
        // on the PC with nothing at all reaching the phone, since
        // nothing else in this path starts or resumes it. Deliberately
        // NOT resumeHlsEncoder() - that now also sends an explicit MPRIS
        // "Play" (see its own comment), which would be sent against the
        // OLD page, before this navigation even happens, racing Spotify's
        // own autoplay. This only needs the encoder to exist by the time
        // real audio shows up, same as the original boot path - no
        // explicit play command required, Spotify does that on its own.
        if (type === "track" && !currentInstance) {
            startEncoderOnceAudioIsReal();
        }

        await page.goto(`https://open.spotify.com/${type}/${id}`, { waitUntil: "domcontentloaded" });
        await injectStateObserver();

        // "main h1" covers track/album/playlist reliably (confirmed
        // live) - artist pages don't render the name as an h1 at all, so
        // there's nothing there to wait for; racing a wait on document.title
        // instead (confirmed live too: it can resolve on the *previous*
        // page's still-lingering title, before the new page has actually
        // replaced it - a real title update and stale leftover text look
        // identical to a bare inequality check) - branching on the type
        // already parsed out of the link sidesteps needing to guess
        // which condition is real
        if (type === "artist") {
            await page.waitForTimeout(2500);
        } else {
            await page.waitForSelector("main h1", { timeout: 8000 }).catch(() => {});
        }

        const result = await page.evaluate((type) => {

            const main = document.querySelector('main');
            const h1 = main?.querySelector('h1');

            const title = h1?.innerText
                || document.title.replace(/\s*[|•]\s*Spotify.*$/, "").trim();

            // artist pages don't have the title/subtitle pair sitting
            // together the way the other types do - just label it like
            // /search already does for artist results elsewhere
            let subtitle = "Artiste";
            if (type !== "artist") {
                let container = h1;
                for (let i = 0; i < 3 && container; i++) container = container.parentElement;
                const spans = container ? [...container.querySelectorAll("span")].map(s => s.innerText).filter(Boolean) : [];
                // [0] type label, [1]/[2] the title itself (duplicated),
                // [3] is the artist/creator name in every type tested
                subtitle = spans[3] || "";
            }

            const cover = main?.querySelector("img")?.src || "";

            return { title, subtitle, cover };

        }, type);

        res.json({ id, type, ...result });

    } catch (e) {
        console.error(e);
        res.status(500).send("resolve-link error");
    }

});

async function scrollArtistDiscographyToFraction(fraction) {

    return await page.evaluate((fraction) => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const card = document.querySelector('[data-testid="artist-page"] [data-encore-id="card"]');
        const container = card ? findScrollable(card) : null;

        if (!container) return false;

        container.scrollTop = (container.scrollHeight - container.clientHeight) * fraction;
        return true;

    }, fraction);

}

async function currentDiscographyScrollInfo() {

    return await page.evaluate(() => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const card = document.querySelector('[data-testid="artist-page"] [data-encore-id="card"]');
        const container = card ? findScrollable(card) : null;

        if (!container) return null;

        return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight
        };

    });

}

// same "virtualized out of the grid" problem as the library sidebar
// list has, but scoped to the artist's own discography grid instead -
// only meaningful on an artist page, so it self-guards on the missing
// container the same way clickDiscographyChip does, and can safely be
// tried even when the tap actually came from the library
async function scrollDiscographyAndRetryClick(clickFn, direction) {

    return pageStepUntilFound(async () => {

        return await page.evaluate(() => {

            function findScrollable(el) {
                while (el && el !== document.body) {
                    const style = getComputedStyle(el);
                    if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                        return el;
                    }
                    el = el.parentElement;
                }
                return null;
            }

            const card = document.querySelector('[data-testid="artist-page"] [data-encore-id="card"]');
            const container = card ? findScrollable(card) : null;

            if (!container) return false;

            if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
            container.focus();

            return document.activeElement === container;

        });

    }, clickFn, direction, async () => {
        const info = await currentDiscographyScrollInfo();
        return info ? info.scrollTop : null;
    });

}

function scrapeDiscographyCardsInView() {

    return page.evaluate(() => {

        const main = document.querySelector('[data-testid="artist-page"]') || document.body;
        const cards = [...main.querySelectorAll('[data-encore-id="card"]')];

        return cards.map(card => {

            const labelledBy = card.getAttribute('aria-labelledby') || "";
            const uriMatch = labelledBy.match(/spotify:(album|track):([a-zA-Z0-9]+)/);

            if (!uriMatch) return null;

            const titleEl = card.querySelector('[id^="card-title-"]');
            const subtitleEl = card.querySelector('[id^="card-subtitle-"]');
            const cover = card.querySelector('[data-testid="card-image"]')?.src || "";

            return {
                id: uriMatch[2],
                type: uriMatch[1],
                title: titleEl?.innerText || "",
                subtitle: subtitleEl?.innerText || "",
                cover
            };

        }).filter(Boolean);

    });

}

// the discography grid is virtualized, so a single scrape only ever
// sees a partial window - scrape the top (the "first render" sent
// back immediately), then jump to the bottom and work upward with the
// grid's own PageUp handling (already tuned to move exactly one
// screenful with no gaps) until the cards seen overlap with the top
// batch, at which point everything in between has been captured. This
// needs no knowledge of the scrollable range or its size, unlike a
// fixed-fraction sweep (tried first, but found to unreliably drop a
// chunk of cards on large discographies)
// how many cards the grid renders on first paint with no scrolling at
// all, measured empirically on artists with large discographies (Bob
// Dylan, Neil Young - both landed on exactly this number, regardless
// of content, so it's a property of the render buffer/viewport size,
// not of any particular artist). A discography whose first render
// comes in under this is necessarily showing everything already - if
// there were more, the buffer would have rendered up to this many
const INITIAL_RENDER_CAPACITY = 49;

async function scrapeAllDiscographyCards(onFirstRender) {

    await scrollArtistDiscographyToFraction(0);
    await page.waitForTimeout(300);

    const initialCards = await scrapeDiscographyCardsInView();

    const initialIds = new Set(initialCards.map(c => c.id));
    const collected = new Map();
    for (const card of initialCards) collected.set(card.id, card);

    if (initialCards.length < INITIAL_RENDER_CAPACITY) {
        if (onFirstRender) onFirstRender(initialCards, true);
        return [...collected.values()];
    }

    const focused = await page.evaluate(() => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const card = document.querySelector('[data-testid="artist-page"] [data-encore-id="card"]');
        const container = card ? findScrollable(card) : null;

        if (!container) return false;

        if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
        container.focus();

        return document.activeElement === container;

    });

    // nothing to scroll - the first batch is already the whole
    // discography, so there's no second, fuller result coming
    if (!focused) {
        if (onFirstRender) onFirstRender(initialCards, true);
        return [...collected.values()];
    }

    // jump to the bottom with the real End key rather than setting
    // scrollTop directly, for the same reason as the playlist scan:
    // consistent with how PageUp is done below, one mechanism throughout
    await page.keyboard.press("End");
    await page.waitForTimeout(600);

    // the container can be "scrollable" purely because of page chrome
    // below the grid (the Spotify footer, mainly) with no extra cards
    // in it at all - check what's actually at the bottom before
    // deciding a second, fuller result is coming
    const bottomCards = await scrapeDiscographyCardsInView();
    const hasNewCards = bottomCards.some(c => !initialIds.has(c.id));

    if (!hasNewCards) {
        if (onFirstRender) onFirstRender(initialCards, true);
        return [...collected.values()];
    }

    if (onFirstRender) onFirstRender(initialCards, false);

    for (const card of bottomCards) collected.set(card.id, card);

    const alreadyOverlapping = bottomCards.some(c => initialIds.has(c.id));

    if (!alreadyOverlapping) {

        const maxPageUps = 40;
        let pageUps = 0;

        while (pageUps < maxPageUps) {

            await page.keyboard.press("PageUp");
            await page.waitForTimeout(350);

            const cards = await scrapeDiscographyCardsInView();
            const hasOverlap = cards.some(c => initialIds.has(c.id));

            for (const card of cards) collected.set(card.id, card);

            if (hasOverlap) break;

            pageUps++;

        }

    }

    return [...collected.values()];

}

function categorizeReleases(releases) {

    const getYear = (r) => {
        const match = r.subtitle?.match(/\d{4}/);
        return match ? Number(match[0]) : Infinity;
    };

    const albums = releases
        .filter(r => r.subtitle?.includes('Album') || r.subtitle?.includes('EP'))
        .sort((a, b) => getYear(b) - getYear(a));

    const singles = releases
        .filter(r => r.subtitle?.includes('Single'))
        .sort((a, b) => getYear(b) - getYear(a));

    const compilations = releases
        .filter(r => r.subtitle?.includes('Compilation'))
        .sort((a, b) => getYear(b) - getYear(a));

    return { albums, singles, compilations };

}

async function scrapeArtistDiscography(onFirstRender) {

    // browser-back (see /browser-back) can land here already sitting on
    // the discography/all sub-page from a previous visit - the shelf
    // this function otherwise clicks through to reach that page doesn't
    // exist there, so re-running those steps would just time out
    // waiting for it. Skip straight to the grid wait in that case.
    if (!page.url().includes("/discography/")) {

        await page.waitForSelector('[data-testid="component-shelf"]', { timeout: 8000 });

        const seeAllClicked = await evaluateAndClick(() => {
            const shelves = [...document.querySelectorAll('[data-testid="component-shelf"]')];
            const discoShelf = shelves.find(s =>
                s.querySelector('[data-testid="rich-title-row-shelf-header"]')?.innerText.startsWith('Discographie')
            );
            return discoShelf?.querySelector('[data-testid="see-all-link"]') || null;
        });

        if (!seeAllClicked) {
            throw new Error("discography not found");
        }

        await page.waitForSelector(
            '[data-testid="artist-page"] button[aria-controls="sort-and-view-picker"]',
            { timeout: 8000 }
        );

        await page.locator(
            '[data-testid="artist-page"] button[aria-controls="sort-and-view-picker"]'
        ).click();

        await page.waitForTimeout(400);

        await evaluateAndClick(() => {
            const menus = [...document.querySelectorAll('[role="menu"]')];
            const viewMenu = menus.find(m => m.innerText.includes("Mode d'affichage"));
            const btn = [...(viewMenu?.querySelectorAll('button, [role="menuitemradio"]') || [])]
                .find(o => o.innerText.trim() === 'Grille');
            return btn || null;
        });

    }

    await page.waitForSelector('[data-encore-id="card"]', { timeout: 8000 });
    await page.waitForTimeout(1000);

    // the right-hand "En cours de lecture" panel eats into the grid's
    // width when open - closing it lets more cards fit per row, so
    // fewer scroll stops are needed to cover the whole discography;
    // checked here (once the grid has settled) rather than right after
    // the "voir tout" click, since the panel's state right after a
    // route transition doesn't reflect what's actually on screen -
    // and the panel is closed by sliding it off-screen, leaving only a
    // narrow collapsed tab overlapping the viewport edge - so presence
    // and a plain overlap check both misread that as "open". Selected
    // by id, not class - its class list changes depending on whether
    // it's showing the queue or the "now playing" view, but the id
    // stays constant either way
    const isRightPanelOnScreen = () => page.evaluate(() => {
        const aside = document.getElementById('Desktop_PanelContainer_Id');
        if (!aside) return false;
        const r = aside.getBoundingClientRect();
        const visibleWidth = Math.min(r.right, window.innerWidth) - Math.max(r.x, 0);
        return visibleWidth > r.width * 0.5;
    });

    if (await isRightPanelOnScreen()) {

        // if it's showing the queue, closing it needs the queue button;
        // the "Masquer la vue En cours de lecture" button only shows up
        // once the queue view itself is closed
        const showingQueue = await page.evaluate(() => !!document.querySelector('ul[aria-label="À suivre"]'));
        if (showingQueue) {
            await page.getByTestId("control-button-queue").click();
            await page.waitForTimeout(500);
        }

        if (await isRightPanelOnScreen()) {
            await evaluateAndClick(() => {
                const btn = [...document.querySelectorAll('button')].find(b =>
                    (b.getAttribute('aria-label') || "").includes('Masquer la vue')
                );
                return btn || null;
            });
            await page.waitForTimeout(500);
        }

    }

    let wasComplete = false;

    const releases = await scrapeAllDiscographyCards((initialCards, isComplete) => {
        wasComplete = isComplete;
        if (onFirstRender) onFirstRender(categorizeReleases(initialCards), isComplete);
    });

    // the 2/3 resting position is meant to leave room for a future
    // direction-based search fallback on a long, virtualized list - a
    // short discography that was already complete on the first render
    // has nothing virtualized to find, so jumping there would just be
    // a pointless extra scroll
    if (!wasComplete) {
        await scrollArtistDiscographyToFraction(2 / 3);
    }

    return categorizeReleases(releases);

}

app.get("/artist", async (req, res) => {

    const id = req.query.id;
    const direction = req.query.direction === "up" ? "up" : "down";

    if (!id) {
        return res.status(400).send("missing id");
    }

    try {

        let navigated = await tryClickAnywhere(id);

        if (!navigated) {
            navigated = await scrollLibraryAndRetryClick(() => tryClickAnywhere(id), direction);
        }

        if (!navigated) {
            navigated = await scrollWhatsNewAndRetryClick(() => tryClickAnywhere(id), direction);
        }

        if (!navigated) {
            return res.status(404).send("not found");
        }

        await page.waitForTimeout(2500);

        res.setHeader("Content-Type", "application/x-ndjson");

        let sentComplete = false;

        const combined = await scrapeArtistDiscography((firstRender, isComplete) => {
            sentComplete = isComplete;
            res.write(JSON.stringify({ ...firstRender, done: isComplete }) + "\n");
        });

        if (!sentComplete) {
            res.write(JSON.stringify({ ...combined, done: true }) + "\n");
        }
        res.end();

    } catch (e) {
        console.error(e);
        if (res.headersSent) {
            res.end();
            return;
        }
        if (e.message === "discography not found") {
            return res.status(404).send("discography not found");
        }
        res.status(500).send("artist error");
    }

});

app.get("/current-artist", async (req, res) => {

    try {

        const navigated = await evaluateAndClick(() => {
            const container = document.querySelector(
                '[data-testid="context-item-info-artist"]'
            );
            const link = container?.matches('a[href*="/artist/"]')
                ? container
                : container?.querySelector('a[href*="/artist/"]');
            return link || null;
        });

        if (!navigated) {
            return res.status(404).send("not found");
        }

        res.setHeader("Content-Type", "application/x-ndjson");

        let sentComplete = false;

        const combined = await scrapeArtistDiscography((firstRender, isComplete) => {
            sentComplete = isComplete;
            res.write(JSON.stringify({ ...firstRender, done: isComplete }) + "\n");
        });

        if (!sentComplete) {
            res.write(JSON.stringify({ ...combined, done: true }) + "\n");
        }
        res.end();

    } catch (e) {
        console.error(e);
        if (res.headersSent) {
            res.end();
            return;
        }
        if (e.message === "discography not found") {
            return res.status(404).send("discography not found");
        }
        res.status(500).send("artist error");
    }

});

async function navigateToCurrentAlbum() {

    return await evaluateAndClick(() => {
        return document.querySelector('[data-testid="context-item-link"]');
    });

}

app.get("/current-album-name", async (req, res) => {

    try {

        const navigated = await navigateToCurrentAlbum();

        if (!navigated) {
            return res.status(404).send("not found");
        }

        await page.waitForSelector('[data-testid="entityTitle"] h1', { timeout: 8000 });

        const name = await page.evaluate(() => {
            const h1 = document.querySelector('[data-testid="entityTitle"] h1');
            return h1?.innerText || "";
        });

        res.json({ name });

    } catch (e) {
        console.error(e);
        res.status(500).send("album name error");
    }

});

app.get("/current-album", async (req, res) => {

    try {

        const navigated = await navigateToCurrentAlbum();

        if (!navigated) {
            return res.status(404).send("not found");
        }

        const results = await scrapeAlbumTracklist();

        res.json(results);

    } catch (e) {
        console.error(e);
        res.status(500).send("album error");
    }

});

async function navigateHome() {

    return await evaluateAndClick(() => {
        return document.querySelector('[data-testid="home-button"]')
            || document.querySelector('a[href="/"]');
    });

}

app.get("/home", async (req, res) => {

    try {

        const navigated = await navigateHome();

        if (!navigated) {
            return res.status(404).send("not found");
        }

        await page.waitForSelector('[data-testid="component-shelf"]', { timeout: 8000 });
        await waitForStableCount(page.locator('[data-testid="component-shelf"]'));

        // one shelf (Spotify's personalized "Pour les fans de..."
        // recommendations row) has no [data-testid="rich-title-row-
        // shelf-header"] at all, confirmed live - it used to be silently
        // dropped here (filter(Boolean) on an empty string), which also
        // meant /home-section could never reach it since that endpoint
        // re-derives the same index space from the same filter. Giving
        // it a fallback label instead keeps every shelf's index aligned
        // 1:1 between this endpoint and /home-section without needing
        // any special-casing on either side.
        const headings = await page.evaluate(() => {

            const shelves = [...document.querySelectorAll('[data-testid="component-shelf"]')];

            return shelves.map(shelf =>
                shelf.querySelector('[data-testid="rich-title-row-shelf-header"] h2')?.innerText || "Suggestions Spotify"
            );

        });

        res.json(headings.map(heading => ({ heading })));

    } catch (e) {
        console.error(e);
        res.status(500).send("home error");
    }

});

app.get("/home-section", async (req, res) => {

    try {

        const index = Number(req.query.index);

        const navigated = await navigateHome();

        if (!navigated) {
            return res.status(404).send("not found");
        }

        await page.waitForSelector('[data-testid="component-shelf"]', { timeout: 8000 });
        await waitForStableCount(page.locator('[data-testid="component-shelf"]'));

        // the "Pour les fans de..." recommendations shelf (last one,
        // see /home's comment) renders its cards' text lazily as they
        // scroll into view - confirmed live: without this, every card's
        // title/subtitle came back empty (data-uri and img src, being
        // plain attributes rather than laid-out text, still worked fine,
        // which is what made this one confusing to track down). Doing
        // this for every index, not just that one shelf, is harmless -
        // an already-visible shelf just gets a no-op scroll.
        await page.evaluate((index) => {
            const shelves = [...document.querySelectorAll('[data-testid="component-shelf"]')];
            shelves[index]?.scrollIntoView({ block: "center" });
        }, index);
        await page.waitForTimeout(400);

        const items = await page.evaluate((index) => {

            const shelves = [...document.querySelectorAll('[data-testid="component-shelf"]')];
            const shelf = shelves[index];

            if (!shelf) return [];

            const cards = [...shelf.querySelectorAll('[data-encore-id="card"]')];

            if (cards.length > 0) {
                return cards.map(card => {

                    const labelledBy = card.getAttribute('aria-labelledby') || "";
                    const uriMatch = labelledBy.match(/spotify:(album|track|artist|playlist|show|episode):([a-zA-Z0-9]+)/);

                    if (!uriMatch) return null;

                    const titleEl = card.querySelector('[id^="card-title-"]');
                    const subtitleEl = card.querySelector('[id^="card-subtitle-"]');
                    const cover = card.querySelector('[data-testid="card-image"]')?.src
                        || card.querySelector('img')?.src || "";

                    return {
                        id: uriMatch[2],
                        type: uriMatch[1],
                        title: titleEl?.innerText || "",
                        subtitle: subtitleEl?.innerText || "",
                        cover
                    };

                }).filter(Boolean);
            }

            // fallback for the "Pour les fans de..." recommendations
            // shelf (see /home's own comment) - confirmed live: its
            // cards have none of the above (no [data-encore-id="card"],
            // no aria-labelledby spotify URI, no card-title-/
            // card-subtitle- ids), but each one still carries a
            // data-uri="spotify:type:id" on an inner element and a real
            // <h2> title, wrapped together with a small type/owner
            // header - dig those out directly instead of giving up.
            const seen = new Set();

            return [...shelf.querySelectorAll('[data-uri]')].map(el => {

                const uriMatch = (el.getAttribute('data-uri') || "")
                    .match(/spotify:(album|track|artist|playlist|show|episode):([a-zA-Z0-9]+)/);

                if (!uriMatch || seen.has(uriMatch[2])) return null;

                let card = el;
                let header = null, titleEl = null;
                for (let i = 0; i < 6 && card; i++) {
                    header = card.querySelector('header');
                    titleEl = card.querySelector('h2');
                    if (header && titleEl) break;
                    card = card.parentElement;
                }

                if (!card || !titleEl) return null;
                seen.add(uriMatch[2]);

                // header wraps the title too (that's how the walk above
                // finds both at once) - strip it back out so subtitle
                // isn't just the title repeated in front of "Playlist •
                // Spotify"/"Album • <owner>" etc. innerText's usual
                // implicit spacing between block-level children doesn't
                // apply here - confirmed live, "Playlist" and "Spotify"
                // sit in adjacent inline spans and innerText ran them
                // together as "PlaylistSpotify" with nothing to split
                // on - so walk the actual text nodes instead and join
                // them explicitly.
                const headerClone = header.cloneNode(true);
                headerClone.querySelector('h2')?.remove();
                const walker = document.createTreeWalker(headerClone, NodeFilter.SHOW_TEXT);
                const parts = [];
                let textNode;
                while ((textNode = walker.nextNode())) {
                    const t = textNode.textContent.trim();
                    if (t) parts.push(t);
                }
                const subtitle = parts.join(" • ");

                // the small contextual caption Spotify shows above each
                // card here ("Pour les fans de X", "Conçu spécialement
                // pour vous"...) lives in a SEPARATE <header>, a direct
                // sibling of `card` one level up - not the same one
                // `subtitle` came from (that one's nested inside `card`
                // itself, wrapping the title/type/owner). Per-card, not
                // shelf-wide, so it goes in `meta` alongside each item
                // rather than in the shelf's own heading.
                const contextHeader = card.parentElement?.querySelector(':scope > header');
                const meta = (contextHeader && contextHeader !== header)
                    ? contextHeader.innerText.trim() || null
                    : null;

                // `card` also contains a decorative carousel of OTHER
                // unrelated covers (cycling background thumbnails, see
                // data-testid="carousel-scroller" inside it) that sits
                // BEFORE the real card image in document order -
                // querying img anywhere in `card` grabbed one of those
                // instead, confirmed live. `header` (the inner one,
                // title/type/owner) is where the actual
                // data-testid="card-image" for this specific item lives,
                // same testid the standard-card branch above already
                // keys off.
                const cover = header.querySelector('[data-testid="card-image"]')?.src
                    || header.querySelector('img')?.src || "";

                return {
                    id: uriMatch[2],
                    type: uriMatch[1],
                    title: titleEl.innerText || "",
                    subtitle,
                    cover,
                    meta
                };

            }).filter(Boolean);

        }, index);

        res.json(items);

    } catch (e) {
        console.error(e);
        res.status(500).send("home section error");
    }

});

// the scrollable area extends past the last real track (padding,
// recommended-tracks section, etc.), so waiting for the scroll position
// to reach the bottom means a couple of extra empty page-downs after
// the last track is already loaded; aria-rowindex/aria-rowcount give
// the real position within the playlist instead
async function isAtLastTrack() {

    return await page.evaluate(() => {

        const rows = [...document.querySelectorAll('[data-testid="tracklist-row"]')];

        if (!rows.length) return false;

        const grid = rows[0].closest('[role="grid"][aria-rowcount]');
        const rowcount = Number(grid?.getAttribute("aria-rowcount"));

        if (!rowcount) return false;

        const indices = rows.map(row => {
            const rowParent = row.closest('[role="row"]');
            return rowParent ? Number(rowParent.getAttribute("aria-rowindex")) : null;
        }).filter(n => n !== null);

        if (!indices.length) return false;

        return Math.max(...indices) >= rowcount;

    });

}

async function scrapeVisibleTracklistRows() {

    return await page.evaluate(() => {

        const rows = [...document.querySelectorAll('[data-testid="tracklist-row"]')]
            .filter(row => !row.closest('[data-testid="recommended-track"]'));

        return rows.map(row => {

            const link = row.querySelector('a[href*="/track/"]');

            if (!link) return null;

            const artistLinks = [...row.querySelectorAll('a[href*="/artist/"]')];
            const cover = row.querySelector('img')?.src || "";

            const rowParent = row.closest('[role="row"]');
            const rowIndex = rowParent ? Number(rowParent.getAttribute("aria-rowindex")) : null;

            const grid = row.closest('[role="grid"][aria-rowcount]');
            const rowCount = grid ? Number(grid.getAttribute("aria-rowcount")) : null;

            return {
                id: link.getAttribute('href').split('/track/')[1],
                type: "track",
                title: link.innerText,
                subtitle: artistLinks.map(a => a.innerText).join(", "),
                cover,
                rowIndex,
                rowCount
            };

        }).filter(Boolean);

    });

}

// albums are short enough to never need the scroll-and-accumulate pass
// below (built for long playlists); scrolling the real page for them
// is pure wasted motion, so just grab whatever is already rendered
async function scrapeAlbumTracklist() {

    await page.waitForSelector('[data-testid="tracklist-row"]', { timeout: 8000 });
    await waitForStableCount(page.locator('[data-testid="tracklist-row"]'));

    return await scrapeVisibleTracklistRows();

}

app.get("/album", async (req, res) => {

    const id = req.query.id;
    const direction = req.query.direction === "up" ? "up" : "down";

    if (!id) {
        return res.status(400).send("missing id");
    }

    try {

        let navigated = await tryClickAnywhere(id);

        if (!navigated && await clickDiscographyChip('Albums')) {
            await page.waitForTimeout(500);
            navigated = await tryClickAnywhere(id);
        }

        if (!navigated && await clickDiscographyChip('Singles et EP')) {
            await page.waitForTimeout(500);
            navigated = await tryClickAnywhere(id);
        }

        // the tap can come from either the artist's own discography grid
        // or the library sidebar - try the grid-scoped scan first (it
        // self-guards to a no-op if there's no artist page to scan),
        // then fall back to the sidebar
        if (!navigated) {
            navigated = await scrollDiscographyAndRetryClick(() => tryClickAnywhere(id), direction);
        }

        if (!navigated) {
            navigated = await scrollLibraryAndRetryClick(() => tryClickAnywhere(id), direction);
        }

        if (!navigated) {
            navigated = await scrollWhatsNewAndRetryClick(() => tryClickAnywhere(id), direction);
        }

        if (!navigated) {
            return res.status(404).send("not found");
        }

        const results = await scrapeAlbumTracklist();

        res.json(results);

    } catch (e) {
        console.error(e);
        res.status(500).send("album error");
    }

});

async function selectLibraryChip(type) {

    const label = { playlists: "Playlists", artists: "Artistes", albums: "Albums" }[type];

    if (!label) return false;

    // the chips (Playlists/Artistes/Albums) aren't shown at all while
    // inside a folder - back out first if needed. Checked here rather
    // than trusted from the client, since the sidebar's own navigation
    // state persists independently of the remote page's lifecycle (a
    // page reload doesn't reset it)
    const inFolder = await page.evaluate(() => {
        const lib = document.querySelector('[class*="YourLibraryX"]');
        return !![...(lib?.querySelectorAll("button") || [])].find(b => b.getAttribute("aria-label") === "Retour");
    });

    if (inFolder) {
        await evaluateAndClick(() => {
            const lib = document.querySelector('[class*="YourLibraryX"]');
            return [...(lib?.querySelectorAll("button") || [])].find(b => b.getAttribute("aria-label") === "Retour") || null;
        });
        await page.waitForTimeout(600);
    }

    async function clickChip() {
        const handle = await page.evaluateHandle((label) => {
            const lib = document.querySelector('[class*="YourLibraryX"]');
            return lib
                ? [...lib.querySelectorAll('[data-encore-id="chip"]')].find(c => c.getAttribute("aria-label") === label) || null
                : null;
        }, label);
        const chip = handle.asElement();
        if (!chip) { await handle.dispose(); return false; }
        // clicking an already-active chip toggles it back off
        const alreadyActive = await chip.evaluate(el => el.getAttribute("aria-checked") === "true");
        if (!alreadyActive) await clickHandle(chip);
        await handle.dispose();
        return true;
    }

    if (await clickChip()) return true;

    // the chip row collapses to just the active filter once one is
    // selected; deselect it first to bring the full chip row back
    await evaluateAndClick(() => {
        const lib = document.querySelector('[class*="YourLibraryX"]');
        return lib
            ? [...lib.querySelectorAll('[data-encore-id="chip"]')].find(c => c.getAttribute("aria-checked") === "true") || null
            : null;
    });

    await page.waitForTimeout(600);

    return await clickChip();

}

async function scrollLibraryToTop() {

    await page.evaluate(() => {
        const container = document.querySelector('[class*="YourLibraryX"] [data-overlayscrollbars-viewport]');
        if (container) container.scrollTop = 0;
    });

}

async function scrollLibraryToFraction(fraction) {

    return await page.evaluate((fraction) => {

        const container = document.querySelector('[class*="YourLibraryX"] [data-overlayscrollbars-viewport]');

        if (!container) return false;

        container.scrollTop = (container.scrollHeight - container.clientHeight) * fraction;

        return true;

    }, fraction);

}

async function tryClickAnywhere(id) {

    // same reasoning as tryClickPlayableElement's own fallback - a
    // shared link (see /resolve-link) already sat the page on this
    // exact entity's own page, so there's nothing to find or click,
    // we're already there
    if (page.url().includes(`/${id}`)) return true;

    return await evaluateAndClick((id) => {

        return document.querySelector(`a[href*="/${id}"]`)
            || document.querySelector(`[role="button"][aria-labelledby*="${id}"]`);

    }, id);

}

// same "id could be virtualized out of the sidebar" problem as long
// playlists have, for library items (playlist/artist/album cards
// found via the sidebar's "Charger plus" scan) - same fix: the client
// says which half of the loaded list it was in, we page toward it
// with real PageUp/PageDown presses and retry the click after each
async function scrollLibraryAndRetryClick(clickFn, direction) {

    return pageStepUntilFound(async () => {

        return await page.evaluate(() => {

            const container = document.querySelector('[class*="YourLibraryX"] [data-overlayscrollbars-viewport]');

            if (!container) return false;

            if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
            container.focus();

            return document.activeElement === container;

        });

    }, clickFn, direction, async () => {
        const info = await currentLibraryScrollInfo();
        return info ? info.scrollTop : null;
    });

}

async function currentLibraryScrollInfo() {

    return await page.evaluate(() => {

        const container = document.querySelector('[class*="YourLibraryX"] [data-overlayscrollbars-viewport]');

        if (!container) return null;

        return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight
        };

    });

}

async function scrapeVisibleLibraryRows() {

    return await page.evaluate((folderIcon) => {

        const lib = document.querySelector('[class*="YourLibraryX"]');

        if (!lib) return [];

        const rows = [...lib.querySelectorAll('[role="row"]')];

        return rows.map(row => {

            const rowIndex = parseInt(row.getAttribute("aria-rowindex"), 10) || 0;

            const listRow = row.querySelector('[data-encore-id="listRow"]');
            const labelledBy = listRow?.getAttribute("aria-labelledby") || "";
            const titleEl = document.getElementById(labelledBy);

            const folderMatch = labelledBy.match(/folder:([a-zA-Z0-9]+)$/);

            if (folderMatch) {
                return {
                    id: folderMatch[1],
                    type: "folder",
                    title: titleEl?.innerText || "",
                    subtitle: "",
                    cover: folderIcon,
                    rowIndex
                };
            }

            // "Titres likés" isn't a real playlist - it's a special
            // spotify:collection:tracks entity with no href, only a
            // role="button" whose aria-labelledby contains this id
            if (labelledBy.includes("collection:tracks")) {
                return {
                    id: "collection:tracks",
                    type: "playlist",
                    title: titleEl?.innerText || "",
                    subtitle: "",
                    cover: row.querySelector("img")?.src || "",
                    rowIndex
                };
            }

            const uriMatch = labelledBy.match(/spotify:(playlist|artist|album):([a-zA-Z0-9]+)$/);

            if (!uriMatch) return null;

            const subtitleEl = document.getElementById(labelledBy.replace("listrow-title-", "listrow-subtitle-"));
            const cover = row.querySelector("img")?.src || "";

            return {
                id: uriMatch[2],
                type: uriMatch[1],
                title: titleEl?.innerText || "",
                subtitle: subtitleEl?.innerText || "",
                cover,
                rowIndex
            };

        }).filter(Boolean);

    }, FOLDER_ICON);

}

// same virtualization problem as the discography grid, so the same
// fix, ported directly: scrape the top batch, focus the list and jump
// to the bottom with the real End key, then walk back up with PageUp
// until the rows seen overlap with the top batch - at that point
// everything in between has been captured. Library rows aren't
// playback-ordered like tracklist rows, so the discography's simpler
// any-overlap stop is safe here too, no need for the exact-count
// approach playlists needed
async function scrapeAllLibraryRows() {

    await scrollLibraryToTop();
    await page.waitForTimeout(300);

    const initialRows = await scrapeVisibleLibraryRows();

    const initialIds = new Set(initialRows.map(r => r.id));
    const collected = new Map();
    for (const row of initialRows) collected.set(row.id, row);

    // scan order jumbles top/bottom/middle batches together - the real
    // sidebar position (aria-rowindex) is the only thing that reflects
    // true list order, same fix as the playlist scan
    const ordered = () => [...collected.values()].sort((a, b) => a.rowIndex - b.rowIndex);

    const focused = await page.evaluate(() => {

        const container = document.querySelector('[class*="YourLibraryX"] [data-overlayscrollbars-viewport]');

        if (!container) return false;

        if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
        container.focus();

        return document.activeElement === container;

    });

    // nothing to scroll - the first batch is already the whole list
    if (!focused) return ordered();

    await page.keyboard.press("End");
    await page.waitForTimeout(600);

    const bottomRows = await scrapeVisibleLibraryRows();
    const hasNewRows = bottomRows.some(r => !initialIds.has(r.id));

    // the container was "scrollable" but nothing new showed up at the
    // bottom (e.g. page chrome below the list) - already complete
    if (!hasNewRows) return ordered();

    for (const row of bottomRows) collected.set(row.id, row);

    const alreadyOverlapping = bottomRows.some(r => initialIds.has(r.id));

    if (!alreadyOverlapping) {

        const maxPageUps = 40;
        let pageUps = 0;

        while (pageUps < maxPageUps) {

            await page.keyboard.press("PageUp");
            await page.waitForTimeout(350);

            const rows = await scrapeVisibleLibraryRows();
            const hasOverlap = rows.some(r => initialIds.has(r.id));

            for (const row of rows) collected.set(row.id, row);

            if (hasOverlap) break;

            pageUps++;

        }

    }

    return ordered();

}

async function currentTracklistScrollInfo() {

    return await page.evaluate(() => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const row = document.querySelector('[data-testid="tracklist-row"]');
        const container = row ? findScrollable(row) : null;

        if (!container) return null;

        return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight
        };

    });

}

async function getPlaylistTrackCount() {

    return await page.evaluate(() => {

        const container = document.querySelector('[data-testid="playlist-page"]');
        if (!container) return null;

        const span = [...container.querySelectorAll('span')].find(el =>
            el.children.length === 0 && /^\d[\d\s ]*\s*(titre|chanson)/i.test(el.textContent.trim())
        );

        if (!span) return null;

        const digits = span.textContent.replace(/[^\d]/g, '');
        return digits ? parseInt(digits, 10) : null;

    });

}

// playlists can be far too long to scan in full, and doing so leaves
// the real page scrolled away from earlier tracks (breaking playback
// for them); instead this pages through in coarse steps, mirroring
// whatever chunk the remote is currently showing
app.get("/playlist", async (req, res) => {

    const id = req.query.id;
    const direction = req.query.direction === "up" ? "up" : "down";

    if (!id) {
        return res.status(400).send("missing id");
    }

    try {

        let navigated = await tryClickAnywhere(id);

        if (!navigated) {
            navigated = await scrollLibraryAndRetryClick(() => tryClickAnywhere(id), direction);
        }

        if (!navigated) {
            navigated = await scrollWhatsNewAndRetryClick(() => tryClickAnywhere(id), direction);
        }

        if (!navigated) {
            return res.status(404).send("not found");
        }

        await page.waitForSelector('[data-testid="tracklist-row"]', { timeout: 8000 });

        await ensureFrenchLocale(id);

        // Diagnostic only (2026-08-26): a /play-result 404 was logged
        // with the page sitting on /collection/tracks right after the
        // user says they were browsing a DIFFERENT playlist - either
        // this navigation never actually landed where scraping/response
        // below implies, or something moved the page again afterward.
        // Logging the url actually reached here narrows down which.
        console.log(`[playlist-diag] id=${id} navigated to url=${page.url()}`);

        await waitForStableCount(page.locator('[data-testid="tracklist-row"]'));

        await scrollTracklistToTop();
        await page.waitForTimeout(300);

        const tracks = await scrapeVisibleTracklistRows();
        const scrollInfo = await currentTracklistScrollInfo();
        const lastTrackLoaded = await isAtLastTrack();

        const atBottom = lastTrackLoaded || (scrollInfo ? (scrollInfo.scrollTop + scrollInfo.clientHeight >= scrollInfo.scrollHeight - 2) : true);

        lastPlaylistInitialTracks = atBottom ? [] : tracks;

        res.json({
            tracks,
            atTop: true,
            atBottom
        });

        // purely prepares the next "Charger plus" call - the remote
        // already has its answer, this shouldn't delay it. Response is
        // already sent, so failures here are just logged, not reported
        if (!atBottom) {
            try {
                await positionTracklistAfterInitialBatch(tracks.length);
            } catch (e) {
                console.error("positionTracklistAfterInitialBatch failed:", e);
            }
        }

    } catch (e) {
        console.error(e);
        res.status(500).send("playlist error");
    }

});

// manual "load more" for long playlists: jump to the bottom with the
// real End key, then work back upward with
// PageUp, scraping at every stop, until a stop contributes no track
// we haven't already seen. Checking for "any overlap with the first
// batch" (like the discography scan does) doesn't work here: right
// after End, the rendered window can contain a partial mix of early
// and late rows at once, which overlaps with the first batch well
// before everything in between has actually been collected. "No new
// tracks at this stop" is the reliable signal instead (confirmed
// empirically: new tracks kept appearing for 10 PageUps after End
// before flattening out, on a playlist where the first overlap
// appeared immediately)
app.get("/playlist-more", async (req, res) => {

    res.setHeader("Content-Type", "application/x-ndjson");

    try {

        // "Charger plus" can be tapped moments after the initial batch
        // is shown - make sure the tracklist has actually finished
        // rendering that batch before treating it as the reference set
        await waitForStableCount(page.locator('[data-testid="tracklist-row"]'), { checks: 2, interval: 300, timeout: 3000 });

        const totalTracks = await getPlaylistTrackCount();

        // /playlist already pre-positions the scrollbar past this batch
        // before responding, so re-scraping "what's visible now" here
        // would skip it entirely - reuse the batch it already captured
        const collected = new Map();
        for (const track of lastPlaylistInitialTracks) collected.set(track.id, track);

        // whatever's visible now is already further ahead thanks to that
        // pre-positioning - scrape it too instead of discarding the head start
        const currentlyVisible = await scrapeVisibleTracklistRows();
        for (const track of currentlyVisible) collected.set(track.id, track);

        // a synthetic container.focus() is unreliable here - a real,
        // trusted click gives focus reliably instead. Clicking a track
        // row would risk starting its playback, so we click the column
        // header row ("# Titre Album Date d'ajout"), which is inert
        const headerHandle = await page.evaluateHandle(() => {

            function findScrollable(el) {
                while (el && el !== document.body) {
                    const style = getComputedStyle(el);
                    if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                        return el;
                    }
                    el = el.parentElement;
                }
                return null;
            }

            const row = document.querySelector('[data-testid="tracklist-row"]');
            const container = row ? findScrollable(row) : null;

            return container ? container.querySelector('[role="row"]') : null;

        });

        const headerEl = headerHandle.asElement();
        const focused = !!headerEl;
        if (headerEl) await headerEl.click({ timeout: 3000 }).catch(() => {});
        await headerHandle.dispose();

        // walk forward from the top in small PageDown steps instead of
        // jumping to the bottom with End and working back up - the render
        // window only turns messy (mixing far-apart rows together) right
        // at the very top/bottom extremes, so incremental forward steps
        // stay clean almost the whole way, and tracks arrive close to
        // playback order already. Stop as soon as the known total (read
        // from the playlist header) is reached; scrollTop plateauing is
        // kept only as a bare safety net for the rare case where the
        // total couldn't be read
        if (focused && (!totalTracks || collected.size < totalTracks)) {

            const maxPageDowns = 40;
            let pageDowns = 0;
            let lastScrollTop = -1;

            while (pageDowns < maxPageDowns) {

                if (totalTracks && collected.size >= totalTracks) break;

                await page.keyboard.press("PageDown");
                await page.waitForTimeout(500);

                const rows = await scrapeVisibleTracklistRows();
                for (const row of rows) collected.set(row.id, row);

                const scrollInfo = await currentTracklistScrollInfo();
                if (scrollInfo && scrollInfo.scrollTop === lastScrollTop) break;
                if (scrollInfo) lastScrollTop = scrollInfo.scrollTop;

                pageDowns++;

            }

        }

        // tracks mostly arrive in playback order already with the forward
        // scan, but sort by the real position (aria-rowindex) anyway as a
        // free correctness net against the rare messy render window
        const orderedTracks = [...collected.values()].sort((a, b) => a.rowIndex - b.rowIndex);

        res.write(JSON.stringify({ tracks: orderedTracks, done: true }) + "\n");
        res.end();

        // leaves the cursor near the bottom (where the scan stopped) -
        // recenter it so the direction-based search fallback (see
        // getDirectionHint in player.js) still has room to move either
        // way if a tap misses a virtualized-out track. Purely prepares
        // future taps - the remote already has its answer, this
        // shouldn't delay it, and failures are just logged
        if (focused) {
            try {
                await scrollTracklistToFraction(0.5);
            } catch (e) {
                console.error("post-scan recenter failed:", e);
            }
        }

    } catch (e) {
        console.error(e);
        res.end();
    }

});

// the sidebar library list (playlists/artists/albums) is virtualized
// the same way tracklists are, so it gets the same coarse pagination
app.get("/library", async (req, res) => {

    const type = req.query.type;

    try {

        const selected = await selectLibraryChip(type);

        if (!selected) {
            return res.status(404).send("filter not found");
        }

        await page.waitForTimeout(600);

        await scrollLibraryToTop();
        await page.waitForTimeout(300);

        const tracks = await scrapeVisibleLibraryRows();
        const scrollInfo = await currentLibraryScrollInfo();

        res.json({
            tracks,
            atTop: true,
            atBottom: scrollInfo ? (scrollInfo.scrollTop + scrollInfo.clientHeight >= scrollInfo.scrollHeight - 2) : true
        });

    } catch (e) {
        console.error(e);
        res.status(500).send("library error");
    }

});

// same "load more" pattern as the discography grid: scrape the top,
// jump to the bottom with the real End key, and walk back up with
// PageUp until the rows seen overlap with the top batch - unlike
// playlists, nothing here plays back "in order", so the discography's
// simpler any-overlap stop applies directly, no exact-count needed
app.get("/library-more", async (req, res) => {

    const type = req.query.type;

    res.setHeader("Content-Type", "application/x-ndjson");

    try {

        const selected = await selectLibraryChip(type);

        if (!selected) {
            res.end();
            return;
        }

        await page.waitForTimeout(600);

        const rows = await scrapeAllLibraryRows();

        res.write(JSON.stringify({ tracks: rows, done: true }) + "\n");
        res.end();

        // leaves the cursor wherever the scan stopped (near the top, once
        // it overlapped with the first batch) - recenter it so the
        // direction-based search fallback (see getDirectionHint in
        // player.js) still has room to move either way if a tap misses a
        // virtualized-out row. Purely prepares future taps - the remote
        // already has its answer, this shouldn't delay it, and failures
        // are just logged
        try {
            await scrollLibraryToFraction(0.5);
        } catch (e) {
            console.error("post-scan library recenter failed:", e);
        }

    } catch (e) {
        console.error(e);
        res.end();
    }

});

// clicking a library folder navigates the sidebar into it (like a
// breadcrumb), rather than expanding it in place, so we scrape its
// contents then use the "Retour" button to back out
async function tryClickFolder(id) {

    return await evaluateAndClick((id) => {

        const lib = document.querySelector('[class*="YourLibraryX"]');

        if (!lib) return null;

        const rows = [...lib.querySelectorAll('[role="row"]')];

        const folderRow = rows.find(row => {
            const labelledBy = row.querySelector('[data-encore-id="listRow"]')?.getAttribute("aria-labelledby") || "";
            return labelledBy.endsWith("folder:" + id);
        });

        return folderRow?.querySelector('[role="button"]') || null;

    }, id);

}

app.get("/library-folder", async (req, res) => {

    const id = req.query.id;
    const direction = req.query.direction === "up" ? "up" : "down";

    if (!id) {
        return res.status(400).send("missing id");
    }

    try {

        let opened = await tryClickFolder(id);

        if (!opened) {
            opened = await scrollLibraryAndRetryClick(() => tryClickFolder(id), direction);
        }

        if (!opened) {
            return res.status(404).send("folder not found");
        }

        await page.waitForTimeout(800);
        await waitForStableCount(page.locator('[class*="YourLibraryX"] [role="row"]'));

        const tracks = await scrapeVisibleLibraryRows();

        // stay inside the folder rather than backing out of it - its
        // contents need to still be visible in the sidebar for
        // tryClickAnywhere/tryClickFolder to find them if the user
        // taps one of them next
        res.json(tracks);

    } catch (e) {
        console.error(e);
        res.status(500).send("library-folder error");
    }

});

// The Android app's own back navigation (BrowseScreen/SearchScreen) only
// updates its local nav stack - the underlying Spotify page never moved,
// so it stays on whatever the user last tapped into (e.g. an album)
// while the app shows a previous screen (e.g. the artist behind it).
// Every subsequent action then 404s, since it searches the CURRENT
// (wrong) page's DOM for elements that only exist on the page the app
// thinks it's showing. Confirmed live 2026-08-19, including reproducing
// it directly: firing this album request concurrently with the previous
// screen's own re-fetch left the real page stuck on the album while the
// artist request 404'd.
//
// Fix: the client calls this route BEFORE popping its own back stack,
// so the real page is already back where the resuming screen expects by
// the time that screen's own onResumed()-triggered re-fetch runs (which
// reuses the ordinary forward-navigation route for that target - most
// of those already no-op their own click step when the page turns out
// to already be on the right entity, e.g. tryClickAnywhere's `if
// (page.url().includes(...)) return true`).
app.get("/browser-back", async (req, res) => {

    try {
        await browserBackClick();
        await page.waitForTimeout(400);
        res.json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(500).send("browser-back error");
    }

});

// the sidebar keeps its own navigation state independent of whatever
// the main content pane is showing (confirmed: browsing into a
// playlist from inside a folder doesn't close the folder in the
// sidebar) - so going "back" to a library/folder view should use the
// sidebar's own real Retour button (to actually exit a folder) or, if
// the sidebar never left that state to begin with, just re-read it
app.get("/library-back", async (req, res) => {

    const exitFolder = req.query.exitFolder === "1";

    try {

        if (exitFolder) {
            const clicked = await evaluateAndClick(() => {
                const lib = document.querySelector('[class*="YourLibraryX"]');
                return [...(lib?.querySelectorAll("button") || [])].find(b => b.getAttribute("aria-label") === "Retour") || null;
            });
            if (clicked) {
                await page.waitForTimeout(500);
                await waitForStableCount(page.locator('[class*="YourLibraryX"] [role="row"]'));
            }
        }

        const tracks = await scrapeVisibleLibraryRows();
        res.json(tracks);

    } catch (e) {
        console.error(e);
        res.status(500).send("library-back error");
    }

});

app.get("/context-and-queue", async (req, res) => {

    try {

        const result = await getContextAndQueue();
        res.json(result);

    } catch (e) {
        console.error(e);
        res.status(500).send("context-and-queue error");
    }

});

app.get("/queue-play", requiresMprisUnblocked(async (req, res) => {

    const index = Number(req.query.index);
    const listType = req.query.list === "manual" ? "manual" : "queue";
    // The client's index is a snapshot from its last /context-and-queue
    // fetch - the real queue can shift between that fetch and the tap
    // actually landing (a track auto-advancing pushes every remaining row
    // down by one), so a bare positional click can land on the wrong,
    // adjacent row. When given, these are what the client expected to
    // find there - verified below before trusting the index, self-
    // correcting by title/artist search instead of just clicking blind.
    const expectedTitle = typeof req.query.title === "string" ? req.query.title : "";
    const expectedSubtitle = typeof req.query.subtitle === "string" ? req.query.subtitle : "";

    if (isNaN(index) || index < 0) {
        return res.status(400).send("invalid index");
    }

    try {

        // Same class of bug /next, /previous and /play-result had: while
        // paused, clicking a queue row's play button makes Spotify start
        // playing with no encoder running to capture it. See their own
        // comments for the full failure mode - fixed here the same way.
        actionGeneration++;
        pendingPlayingIntent = null;
        await ensureEncoderRunning();

        // no longer guaranteed to already be open now that the panel
        // isn't kept open by a separate polling call - reopen it here
        // if needed, same as everywhere else that reads it
        let list = await page.$('ul[aria-label="À suivre"]');
        if (!list) {
            await page.getByTestId("control-button-queue").click();
            await page.waitForSelector('ul[aria-label="À suivre"]', { timeout: 8000 });
        }

        const selector = listType === "manual"
            ? 'ul[aria-label="À suivre dans la file d\'attente"]'
            : 'ul[aria-label="À suivre"]';

        const clicked = await evaluateAndClick(({ selector, index, expectedTitle, expectedSubtitle }) => {

            const list = document.querySelector(selector);
            if (!list) return null;

            const rows = [...list.querySelectorAll('li[role="row"]')];

            // Must match getContextAndQueue's own scrapeRows() exactly -
            // expectedTitle/expectedSubtitle are what that function sent
            // the client in the first place. A plain subtitleEl.innerText
            // here (the whole container's raw text) doesn't equal what
            // scrapeRows actually reports whenever the subtitle holds
            // artist <a> links: scrapeRows joins just the links' own
            // innerText with ", ", not the container's full text, which
            // silently differs from it - confirmed live, breaking the
            // exact-match check below and 404ing every queue-play tap.
            function rowText(row) {
                const titleEl = row.querySelector('[id^="listrow-title-"]');
                const subtitleEl = row.querySelector('[id^="listrow-subtitle-"]');
                const artistLinks = [...(subtitleEl?.querySelectorAll('a') || [])];
                const subtitle = artistLinks.length
                    ? artistLinks.map(a => a.innerText).join(", ")
                    : (subtitleEl?.innerText || "");
                return { title: titleEl?.innerText || "", subtitle };
            }

            let target = rows[index];

            if (expectedTitle) {
                const matchesExpected = (row) => {
                    if (!row) return false;
                    const { title, subtitle } = rowText(row);
                    return title === expectedTitle && (!expectedSubtitle || subtitle === expectedSubtitle);
                };
                if (!matchesExpected(target)) {
                    target = rows.find(matchesExpected);
                }
            }

            if (!target) return null;

            return target.querySelector('[data-testid="play-button"]');

        }, { selector, index, expectedTitle, expectedSubtitle });

        if (!clicked) {
            return res.status(404).send("not found");
        }

        res.send("ok");

        // No selfHealTowards() here either - see /play-result's own
        // comment. Same real-DOM-click track switch, same risk of
        // toggling back into the previous track mid-transition.

    } catch (e) {
        console.error(e);
        res.status(500).send("queue-play error");
    }

}));

app.get("/queue-remove", async (req, res) => {

    const index = Number(req.query.index);
    const listType = req.query.list === "manual" ? "manual" : "queue";

    if (isNaN(index) || index < 0) {
        return res.status(400).send("invalid index");
    }

    try {

        let list = await page.$('ul[aria-label="À suivre"]');
        if (!list) {
            await page.getByTestId("control-button-queue").click();
            await page.waitForSelector('ul[aria-label="À suivre"]', { timeout: 8000 });
        }

        const selector = listType === "manual"
            ? 'ul[aria-label="À suivre dans la file d\'attente"]'
            : 'ul[aria-label="À suivre"]';

        const countBefore = await page.evaluate((selector) => {
            const list = document.querySelector(selector);
            return list ? list.querySelectorAll('li[role="row"]').length : 0;
        }, selector);

        const opened = await evaluateAndClick(({ selector, index }) => {

            const list = document.querySelector(selector);
            if (!list) return null;

            const row = list.querySelectorAll('li[role="row"]')[index];
            if (!row) return null;

            return row.querySelector('[data-testid="more-button"]');

        }, { selector, index });

        if (!opened) {
            return res.status(404).send("not found");
        }

        await page.waitForSelector('[role="menu"]', { timeout: 3000 }).catch(() => {});

        const clicked = await evaluateAndClick(() => {

            const menu = document.querySelector('[role="menu"]');
            if (!menu) return null;

            return [...menu.querySelectorAll('[role="menuitem"]')].find(i =>
                i.innerText.trim() === "Supprimer de la file d'attente"
            ) || null;

        });

        if (!clicked) {
            await page.keyboard.press("Escape").catch(() => {});
        } else {
            // the row's removal is animated on Spotify's side - a fixed
            // wait here was sometimes too short, leaving the client's
            // immediate refresh to catch a stale, not-yet-updated list.
            // Wait for the row count to actually drop instead
            await page.waitForFunction(
                ({ selector, countBefore }) => {
                    const list = document.querySelector(selector);
                    const count = list ? list.querySelectorAll('li[role="row"]').length : 0;
                    return count < countBefore;
                },
                { selector, countBefore },
                { timeout: 3000 }
            ).catch(() => {});
        }

        res.send(clicked ? "ok" : "not found");

    } catch (e) {
        console.error(e);
        res.status(500).send("queue-remove error");
    }

});

app.get("/seek", async (req, res) => {

    const percent = Number(req.query.percent);

    if (isNaN(percent) || percent < 0 || percent > 1) {
        return res.status(400).send("invalid percent");
    }

    await page.evaluate((percent) => {

        const input = document.querySelector(
            '[data-testid="playback-progressbar"] input[type="range"]'
        );

        if (!input) {
            throw new Error("Seek input introuvable");
        }

        const max = Number(input.max);

        input.value = Math.floor(max * percent);

        input.dispatchEvent(
            new Event("input", { bubbles: true })
        );

        input.dispatchEvent(
            new Event("change", { bubbles: true })
        );

    }, percent);

    res.send("ok");
});

// Pushes state to /state-stream clients the moment the page's own DOM
// actually changes, instead of each client polling on its own schedule.
// Observes document.body broadly (rather than pinning down every
// individual testid container, which Spotify's own SPA restructures
// often enough to be fragile) and debounces in-page before ever calling
// back into Node - most mutations across the whole page touch none of
// the fields /state reports at all (hover states, unrelated
// animations); pushStateIfChanged's own before/after comparison is what
// actually filters those out, this debounce just keeps the round trip
// into Node from firing on every single one of them.
async function exposeStateChangeBinding() {
    await page.exposeFunction("__notifyStateMightHaveChanged", () => {
        pushStateIfChanged();
    });
}

// (Re)installs the DOM observer that drives live state pushes. Needed
// once at boot, and again after ANY real navigation (page.goto/
// page.reload) - those replace the document entirely, silently dropping
// whatever a plain page.evaluate() previously injected into it (unlike
// page.exposeFunction's binding above, which Playwright automatically
// reinstalls on every new document, so that part doesn't need repeating).
// Confirmed live: forgetting this after a real navigation doesn't error
// anywhere, it just silently stops all future state pushes for the rest
// of the process, surfacing as "the PC plays fine but the app stops
// following" - easy to miss until exactly that's reported. The explicit
// call sites (fixArabicLocaleBug, /resolve-link) cover navigations this
// code itself triggers; connectSpotify's page.on("load") listener
// covers everything else (e.g. a manual F5 outside this code) so this
// doesn't depend on enumerating every possible trigger.
async function injectStateObserver() {

    await page.evaluate(() => {
        let debounceTimer = null;
        const observer = new MutationObserver(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                window.__notifyStateMightHaveChanged();
            }, 200);
        });
        observer.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true
        });
    });

}

async function setupStatePush() {
    await exposeStateChangeBinding();
    await injectStateObserver();
}

const httpServer = app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server listening on port ${PORT} (HTTP)`);
    await connectSpotify();
    await setupStatePush();
    // matches /pause and /play's own rule: the encoder should only run
    // while Spotify is actually playing - a server restart while
    // already paused shouldn't leave it running until the next tap
    const alreadyPlaying = (await controls.playPause.getAttribute("aria-label")) === "Pause";
    if (alreadyPlaying) startEncoderOnceAudioIsReal();
});

// Clients connect here instead of polling /state - sent the current
// state right away on connect, then pushed to again only when
// pushStateIfChanged (the DOM observer above, or an optimistic
// pendingPlayingIntent update from /play, /pause, /next, /previous)
// actually finds something changed.
const wss = new WebSocketServer({ server: httpServer, path: "/state-stream" });

wss.on("connection", async (ws) => {
    wsClients.add(ws);
    try {
        ws.send(JSON.stringify(applyPendingIntent(await scrapeState())));
    } catch (e) {
        console.error(e);
    }
    ws.on("close", () => wsClients.delete(ws));
});
