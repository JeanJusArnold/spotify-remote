import {
    cmd,
    doSearch,
    cancelLoadOrClose,
    browseCurrentArtist,
    handleCoverTap,
    browseHome,
    goBack,
    updateSearchGhost,
    commitSeek,
    updateSeekbarFill,
    setSeeking,
    startPolling,
    stopPolling,
    handleTrackActionClick,
    updateQueueScrollThumb,
    updateManualQueueScrollThumb,
    getLastState,
    onStateUpdate
} from "./player.js";

const topbar = document.getElementById("topbar");

const titleWords = topbar.textContent.trim().split(" ").map(word => {
    const letters = word.split("").map(ch =>
        '<span class="key">' + ch + '</span>'
    ).join("");
    return '<span class="word">' + letters + '</span>';
}).join("");

topbar.innerHTML = '<span class="title-frame">' + titleWords + '</span>';

topbar.addEventListener("click", browseHome);


document.getElementById("searchCloseButton").addEventListener("click", cancelLoadOrClose);
document.getElementById("searchButton").addEventListener("click", () => doSearch());
document.getElementById("overlayBackButton").addEventListener("click", goBack);

document.getElementById("trackActionQueue").addEventListener("click", handleTrackActionClick);

document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        doSearch();
    }
});

document.getElementById("searchInput").addEventListener("input", updateSearchGhost);

document.getElementById("artist").addEventListener("click", browseCurrentArtist);

const cover = document.getElementById("cover");

cover.addEventListener("pointerdown", (e) => {
    e.preventDefault();
});

cover.addEventListener("contextmenu", (e) => {
    e.preventDefault();
});

cover.addEventListener("pointerup", (e) => {
    e.preventDefault();
    handleCoverTap();
});

document.getElementById("shuffleBtn").addEventListener("click", () => cmd("shuffle"));
document.getElementById("prevBtn").addEventListener("click", () => cmd("previous"));
document.getElementById("play").addEventListener("click", () => cmd("playpause"));
document.getElementById("nextBtn").addEventListener("click", () => cmd("next"));
document.getElementById("repeatBtn").addEventListener("click", () => cmd("repeat"));


const seekbar = document.getElementById("seekbar");

seekbar.addEventListener("pointerdown", () => setSeeking(true));
seekbar.addEventListener("input", updateSeekbarFill);
seekbar.addEventListener("change", commitSeek);
seekbar.addEventListener("pointerup", commitSeek);
seekbar.addEventListener("pointercancel", commitSeek);

updateSeekbarFill();


document.getElementById("queueList").addEventListener("scroll", updateQueueScrollThumb);
document.getElementById("manualQueueList").addEventListener("scroll", updateManualQueueScrollThumb);
window.addEventListener("resize", updateQueueScrollThumb);
window.addEventListener("resize", updateManualQueueScrollThumb);

// mobile Chrome's collapsing/expanding URL bar (often triggered right
// when an inner scroll hits its bottom) resizes the viewport without
// firing a plain window "resize" event - visualViewport is the event
// that actually fires for it, and without this the thumb can get stuck
// on a size computed mid-transition
if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateQueueScrollThumb);
    window.visualViewport.addEventListener("resize", updateManualQueueScrollThumb);
}


document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        stopPolling();
    } else {
        startPolling();
    }
});

if (!document.hidden) {
    startPolling();
}


// Off-wifi (e.g. mobile data away from home), pausing Spotify alone
// still leaves AudioRelay's connection open and transmitting (measured:
// ~240KB dropping to ~70KB per 10s while paused - real, but far from
// zero), so it wastes meaningfully more battery/data than actually
// closing the connection would (which AudioRelay's own controls do).
// This overlay is just a reminder of that, not an enforced redirect - a
// single tap dismisses it and reveals the real button underneath. Not
// shown on wifi, where that gap is negligible either way.
const audioRelayOverlay = document.getElementById("audioRelayOverlay");

// dismissing the overlay (tapping it) only clears the way for the next
// use of the real button - it re-arms right after (see the #play click
// handler below), and also resets if wifi comes back and goes away again
let audioRelayOverlayDismissed = false;

function updateAudioRelayOverlay() {
    const connection = navigator.connection;
    // if the browser doesn't support the Network Information API, default
    // to not restricting anything rather than guessing
    const isWifi = !connection || !connection.type || connection.type === "wifi";
    if (isWifi) {
        audioRelayOverlayDismissed = false;
        audioRelayOverlay.classList.remove("visible");
        return;
    }

    // if Spotify's play state and AudioRelay's connection state already
    // don't match (paused but still connected, or playing but
    // disconnected - e.g. someone hit play directly in the web player),
    // the sync this overlay exists to protect is already broken. Showing
    // it would misleadingly suggest tapping it fixes something, when that
    // mismatch exists regardless of the remote's own button - better to
    // leave the real button reachable so it can be used to resolve it
    // (a straight cmp against audioRelayConnected being exactly null,
    // e.g. AudioRelay isn't part of this setup at all, also counts as a
    // mismatch here, which is the point - nothing to protect then either)
    const state = getLastState();
    const alreadyInconsistent =
        !!state && state.playing !== state.audioRelayConnected;

    audioRelayOverlay.classList.toggle(
        "visible", !audioRelayOverlayDismissed && !alreadyInconsistent
    );
}

audioRelayOverlay.addEventListener("click", () => {
    // paused with AudioRelay already disconnected is a properly synced
    // "off" state - the real button underneath would only do Play from
    // here, which AudioRelay wouldn't be there to receive, creating a
    // fresh inconsistency instead of just accepting the comparatively
    // harmless cost a manual pause has in the normal case. So this one
    // combination doesn't get dismissed by tapping it.
    const state = getLastState();
    const wouldCreateInconsistency =
        !!state && state.playing === false && state.audioRelayConnected === false;
    if (wouldCreateInconsistency) return;

    audioRelayOverlayDismissed = true;
    audioRelayOverlay.classList.remove("visible");
});

// dismissing only clears the way for the next tap on the real button -
// using it re-arms the reminder rather than leaving it dismissed for the
// rest of the off-wifi stretch. The 2s fade-in (see .audiorelay-overlay's
// transition) is what actually gives that tap room to land before the
// overlay is back over the button, not a delay here.
document.getElementById("play").addEventListener("click", () => {
    audioRelayOverlayDismissed = false;
    updateAudioRelayOverlay();
});

if (navigator.connection) {
    navigator.connection.addEventListener("change", updateAudioRelayOverlay);
}
onStateUpdate(updateAudioRelayOverlay);
updateAudioRelayOverlay();
