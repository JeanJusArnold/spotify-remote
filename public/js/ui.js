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
    queueAddActiveTrack,
    updateQueueScrollThumb
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

document.getElementById("trackActionQueue").addEventListener("click", queueAddActiveTrack);

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
window.addEventListener("resize", updateQueueScrollThumb);

// mobile Chrome's collapsing/expanding URL bar (often triggered right
// when an inner scroll hits its bottom) resizes the viewport without
// firing a plain window "resize" event - visualViewport is the event
// that actually fires for it, and without this the thumb can get stuck
// on a size computed mid-transition
if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateQueueScrollThumb);
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
