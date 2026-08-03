import * as api from "./api.js";

export let seeking = false;

export function setSeeking(value) {
    seeking = value;
}

function toSeconds(t) {
    if (!t) return 0;
    const p = t.split(":");
    return Number(p[0]) * 60 + Number(p[1]);
}

const marqueeState = {};

function setMarqueeText(id, text) {

    if (marqueeState[id] === text) return;
    marqueeState[id] = text;

    const span = document.getElementById(id);
    const wrapper = span.parentElement;

    span.innerText = text;
    wrapper.classList.remove("overflow");
    span.style.animationDuration = "";
    span.style.removeProperty("--scroll-distance");

    requestAnimationFrame(() => {

        const overflow = span.scrollWidth - wrapper.clientWidth;

        if (overflow > 4) {

            span.style.setProperty("--scroll-distance", (-overflow - 10) + "px");
            span.style.animationDuration = Math.max(4, overflow / 25) + "s";

            wrapper.classList.add("overflow");

        }

    });

}

export function updateSeekbarFill() {

    const seekbar = document.getElementById("seekbar");

    const percent = (seekbar.value / seekbar.max) * 100;

    seekbar.style.background =
        "linear-gradient(to right, #fff " + percent + "%, #555 " + percent + "%)";

}

let coverTappedForCurrentAlbum = false;
let currentAlbumCoverKey = "";

let lastKnownTitle = null;

export async function updateState() {

    try {

        const state = await api.getState();

        // the context name and the "up next" queue both require
        // opening the webplayer's queue panel to read, unlike
        // everything else here - only worth doing when the track has
        // actually changed, not on every 2s poll
        if (state.title !== lastKnownTitle) {
            lastKnownTitle = state.title;
            refreshContextAndQueue();
        }

        if (state.cover && state.cover !== currentAlbumCoverKey) {
            currentAlbumCoverKey = state.cover;
            coverTappedForCurrentAlbum = false;
        }

        setMarqueeText("trackText", state.title || "Aucun titre");
        setMarqueeText("artistText", state.artist || "");

        document.getElementById("iconPlay").style.display =
            state.playing ? "none" : "block";

        document.getElementById("iconPause").style.display =
            state.playing ? "flex" : "none";

        document.getElementById("shuffleBtn").classList.toggle(
            "active", !!state.shuffle
        );

        document.getElementById("repeatBtn").classList.toggle(
            "active", state.repeat !== "off"
        );

        document.getElementById("repeatDot").style.display =
            state.repeat === "track" ? "block" : "none";

        if (state.cover) {
            document.getElementById("cover").src = state.cover;
        }

        document.getElementById("time").innerText =
            (state.position || "0:00") + " / " + (state.duration || "0:00");

        const duration = toSeconds(state.duration);
        const position = toSeconds(state.position);

        if (duration && !seeking) {

            const seekbar = document.getElementById("seekbar");
            seekbar.value = Math.floor((position / duration) * 1000);

            updateSeekbarFill();

        }

    }
    catch (e) {
        console.log(e);
    }

}

let lastQueueSignature = "";

// the context name and the "up next" list both require the webplayer's
// queue panel to be open to read - only called when the track changes
// (see updateState), not on a fixed interval, and skipped entirely
// while the remote's own overlay is covering the screen (or a browse
// load is in flight, which will show the overlay soon) since neither
// piece is visible then anyway
async function refreshContextAndQueue() {

    if (document.getElementById("searchOverlay").classList.contains("open") || currentAbortController !== null) return;

    try {

        const data = await api.getContextAndQueue();

        document.getElementById("queueContext").innerText =
            data.context ? "(" + data.context + ")" : "";

        const signature = JSON.stringify(data.queue);

        if (signature === lastQueueSignature) return;
        lastQueueSignature = signature;

        const queueListEl = document.getElementById("queueList");

        queueListEl.innerHTML = "";

        data.queue.forEach((item, index) => {

            const row = document.createElement("div");
            row.className = "result-item";

            row.innerHTML =
                '<img src="' + item.cover + '">' +
                '<div class="result-info">' +
                '<div class="result-title">' + item.title + '</div>' +
                '<div class="result-artist">' + item.subtitle + '</div>' +
                '</div>';

            row.addEventListener("click", async () => {
                await api.playQueueItem(index);
                updateState();
            });

            queueListEl.appendChild(row);

        });

    }
    catch (e) {
        console.log(e);
    }

}

let titleKeys = null;

function getTitleKeys() {
    if (!titleKeys) {
        titleKeys = [...document.querySelectorAll("#topbar .key")];
    }
    return titleKeys;
}

let typingTimer = null;
let typingActive = false;

export function startTypingAnimation() {

    if (typingActive) return;
    typingActive = true;

    document.getElementById("topbar").classList.add("loading");

    const keys = getTitleKeys();
    let i = 0;

    const pressNext = () => {

        if (!typingActive) return;

        keys.forEach(k => k.classList.remove("pressed"));
        keys[i % keys.length].classList.add("pressed");

        i++;

        typingTimer = setTimeout(pressNext, 90);

    };

    pressNext();

}

export function stopTypingAnimation() {

    typingActive = false;
    clearTimeout(typingTimer);
    getTitleKeys().forEach(k => k.classList.remove("pressed"));

    document.getElementById("topbar").classList.remove("loading");

}

let currentAbortController = null;

// aborts the previous in-flight browse request (if any) and starts
// tracking a new one, so a stray earlier response can't overwrite a
// more recent view once it eventually arrives
function beginAbortableLoad() {

    if (currentAbortController) {
        currentAbortController.abort();
    }

    const controller = new AbortController();
    currentAbortController = controller;

    startTypingAnimation();

    return controller.signal;

}

function endAbortableLoad() {
    currentAbortController = null;
    stopTypingAnimation();
}

export function cancelLoadOrClose() {
    if (currentAbortController) {
        currentAbortController.abort();
    } else {
        closeSearch();
    }
}

export function showSearchOverlay() {
    document.getElementById("searchOverlay").classList.add("open");
}

export function hideSearchOverlay() {
    document.getElementById("searchOverlay").classList.remove("open");
    // polling is suspended while the overlay covers the player view -
    // refresh immediately so it isn't showing stale info for up to 2s
    updateState();
}

function applyFallbackCovers(results, fallbackCover) {
    for (const result of results) {
        result.cover = result.cover || fallbackCover || "";
    }
}

let accumulatedTracks = [];

function resetLoadMoreState() {
    accumulatedTracks = [];
    hideLoadMoreButton();
}

// consecutive pages overlap (the server scrolls by ~85% of the
// viewport, not a full page), so a plain concat would show a few
// tracks twice - this finds how much of the new batch is already at
// the matching edge of what's accumulated and drops just that part
function trimOverlapDown(existing, incoming) {

    const maxK = Math.min(existing.length, incoming.length);

    for (let k = maxK; k > 0; k--) {

        const existingTail = existing.slice(existing.length - k).map(t => t.id).join(",");
        const incomingHead = incoming.slice(0, k).map(t => t.id).join(",");

        if (existingTail === incomingHead) return incoming.slice(k);

    }

    return incoming;

}

function resetAccumulated(tracks) {
    accumulatedTracks = tracks.slice();
    renderResults(tracks);
}

function showLoadMoreButton(onClick) {

    hideLoadMoreButton();

    const button = document.createElement("button");
    button.id = "loadMoreTracksButton";
    button.className = "load-more-btn";
    button.innerHTML = '<span class="icon-chevron-down-small"></span> Charger plus';

    button.addEventListener("click", () => {
        button.disabled = true;
        onClick();
    });

    document.getElementById("searchResults").appendChild(button);

}

function hideLoadMoreButton() {
    document.getElementById("loadMoreTracksButton")?.remove();
}

let playlistLoadMoreFallbackCover = "";

async function loadMorePlaylistTracks() {

    hideLoadMoreButton();

    const signal = beginAbortableLoad();

    try {

        await api.getPlaylistMore(signal, (chunk) => {
            applyFallbackCovers(chunk.tracks, playlistLoadMoreFallbackCover);
            // the server now sends the whole, correctly-ordered list in
            // one final chunk (not incremental pages to merge), so
            // replace outright rather than trying to append/de-overlap
            resetAccumulated(chunk.tracks);
        });

        endAbortableLoad();

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return;

        console.log(e);
    }

}

let libraryLoadMoreType = "";

async function loadMoreLibraryTracks() {

    hideLoadMoreButton();

    const signal = beginAbortableLoad();

    try {

        await api.getLibraryMore(libraryLoadMoreType, signal, (chunk) => {
            appendAccumulated(chunk.tracks);
        });

        endAbortableLoad();

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return;

        console.log(e);
    }

}

function appendAccumulated(newTracks) {

    const trimmed = trimOverlapDown(accumulatedTracks, newTracks);
    accumulatedTracks = accumulatedTracks.concat(trimmed);

    const resultsEl = document.getElementById("searchResults");

    for (const track of trimmed) {
        resultsEl.appendChild(createResultItem(track));
    }

}

function createResultItem(result) {

    const item = document.createElement("div");
    item.className = "result-item";

    item.innerHTML =
        '<img src="' + result.cover + '">' +
        '<div class="result-info">' +
        '<div class="result-title">' + result.title + '</div>' +
        '<div class="result-artist">' + result.subtitle + '</div>' +
        '</div>';

    item.addEventListener("click", () => {
        if (result.type === "artist") {
            browseArtist(result.id, result.cover, result.title);
        } else if (result.type === "album") {
            browseAlbum(result.id, result.cover, result.title);
        } else if (result.type === "playlist") {
            browsePlaylist(result.id, result.cover, result.title);
        } else if (result.type === "folder") {
            browseLibraryFolder(result.id, result.title);
        } else {
            playResult(result.id);
        }
    });

    return item;

}

function setOverlayLocation(text) {
    document.getElementById("overlayLocation").innerText = text || "";
}

function appendCollapsibleSection(heading, items) {

    const resultsEl = document.getElementById("searchResults");

    const headingEl = document.createElement("div");
    headingEl.className = "section-heading";
    headingEl.innerHTML =
        '<span class="section-heading-text">' + heading + '</span>' +
        '<span class="section-chevron"></span>';

    const itemsContainer = document.createElement("div");
    itemsContainer.className = "section-items";

    let loaded = false;

    headingEl.addEventListener("click", () => {

        const expanding = !headingEl.classList.contains("expanded");

        headingEl.classList.toggle("expanded", expanding);
        itemsContainer.classList.toggle("expanded", expanding);

        if (expanding && !loaded) {
            loaded = true;
            for (const item of items) {
                itemsContainer.appendChild(createResultItem(item));
            }
        }

    });

    resultsEl.appendChild(headingEl);
    resultsEl.appendChild(itemsContainer);

}

function renderArtistDiscography(albums, singles, compilations) {

    const resultsEl = document.getElementById("searchResults");

    resultsEl.innerHTML = "";
    resultsEl.scrollTop = 0;

    if (!albums.length && !singles.length && !compilations.length) {
        resultsEl.innerText = "Aucun résultat";
        return;
    }

    for (const album of albums) {
        resultsEl.appendChild(createResultItem(album));
    }

    if (singles.length) {
        appendCollapsibleSection("Singles", singles);
    }

    if (compilations.length) {
        appendCollapsibleSection("Compilations", compilations);
    }

}

export function renderResults(results) {

    const resultsEl = document.getElementById("searchResults");

    resultsEl.innerHTML = "";
    resultsEl.scrollTop = 0;

    if (!results.length) {
        resultsEl.innerText = "Aucun résultat";
        return;
    }

    for (const result of results) {
        resultsEl.appendChild(createResultItem(result));
    }

}

async function loadHomeSection(index, itemsContainer) {

    const signal = beginAbortableLoad();

    try {

        const items = await api.getHomeSection(index, signal);

        endAbortableLoad();

        itemsContainer.innerHTML = "";

        for (const item of items) {
            itemsContainer.appendChild(createResultItem(item));
        }

        return true;

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return false;

        itemsContainer.innerText = "Erreur";
        console.log(e);
        return false;
    }

}

export function renderSections(sections) {

    const resultsEl = document.getElementById("searchResults");

    resultsEl.innerHTML = "";
    resultsEl.scrollTop = 0;

    if (!sections.length) {
        resultsEl.innerText = "Aucun résultat";
        return;
    }

    sections.forEach((section, index) => {

        const heading = document.createElement("div");
        heading.className = "section-heading";
        heading.innerHTML =
            '<span class="section-heading-text">' + section.heading + '</span>' +
            '<span class="section-chevron"></span>';

        const itemsContainer = document.createElement("div");
        itemsContainer.className = "section-items";

        let loaded = false;

        heading.addEventListener("click", () => {

            const expanding = !heading.classList.contains("expanded");

            heading.classList.toggle("expanded", expanding);
            itemsContainer.classList.toggle("expanded", expanding);

            if (expanding && !loaded) {
                loaded = true;
                itemsContainer.innerText = "...";
                loadHomeSection(index, itemsContainer).then(success => {
                    loaded = success;
                });
            }

        });

        resultsEl.appendChild(heading);
        resultsEl.appendChild(itemsContainer);

    });

}

let homeOverlayActive = false;

// each browse function calls recordView() with a descriptor of what it
// shows, so goBack() can replay the previous one by re-calling the
// same function with the same arguments - isGoingBack suppresses
// re-pushing the view we're navigating back TO while it's being replayed
let navigationStack = [];
let currentViewDescriptor = null;
let isGoingBack = false;

function recordView(descriptor) {
    if (!isGoingBack && currentViewDescriptor) {
        navigationStack.push(currentViewDescriptor);
    }
    isGoingBack = false;
    currentViewDescriptor = descriptor;
    document.getElementById("overlayBackButton").classList.toggle("visible", navigationStack.length > 0);
}

function resetNavigationHistory() {
    navigationStack = [];
    currentViewDescriptor = null;
    document.getElementById("overlayBackButton").classList.remove("visible");
}

export function goBack() {

    if (navigationStack.length === 0) return;

    const view = navigationStack.pop();
    isGoingBack = true;
    document.getElementById("overlayBackButton").classList.toggle("visible", navigationStack.length > 0);

    if (view.type === "search") doSearch(view.query);
    else if (view.type === "artist") browseArtist(view.id, view.cover, view.title);
    else if (view.type === "album") browseAlbum(view.id, view.cover, view.title);
    else if (view.type === "playlist") browsePlaylist(view.id, view.cover, view.title);
    else if (view.type === "library" || view.type === "libraryFolder") goBackInLibrary(view);
    else if (view.type === "currentArtist") browseCurrentArtist();
    else if (view.type === "currentAlbum") browseCurrentAlbum();
    else if (view.type === "home") browseHome();

}

// replays a library/libraryFolder view without re-fetching from
// scratch - going back to the top level asks the server to click the
// sidebar's real Retour button (it checks first whether one is even
// there, so this is safe to ask for unconditionally); going back to a
// specific folder just re-reads whatever the sidebar already shows,
// since it never left that folder to begin with
async function goBackInLibrary(view) {

    const exitFolder = view.type === "library";

    resetLoadMoreState();
    homeOverlayActive = false;

    const signal = beginAbortableLoad();

    try {

        const results = await api.getLibraryBack(exitFolder, signal);

        endAbortableLoad();
        recordView(view);
        setOverlayLocation(view.type === "library" ? libraryTypeLabels[view.libType] : view.title);
        showSearchOverlay();
        renderResults(results);

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return;

        showSearchOverlay();
        document.getElementById("searchResults").innerText = "Erreur";
        console.log(e);
    }

}

const librarySearchShortcuts = { p: "playlists", ar: "artists", al: "albums" };
const librarySearchShortcutLabels = { p: "Playlists", ar: "Artistes", al: "Albums" };

export function updateSearchGhost() {

    const value = document.getElementById("searchInput").value;
    const label = librarySearchShortcutLabels[value.trim().toLowerCase()];

    const ghostTyped = document.querySelector("#searchGhost .ghost-typed");
    const ghostSuggestion = document.querySelector("#searchGhost .ghost-suggestion");

    if (label) {
        ghostTyped.innerText = value;
        ghostSuggestion.innerText = label.slice(value.trim().length);
    } else {
        ghostTyped.innerText = "";
        ghostSuggestion.innerText = "";
    }

}

export async function doSearch(overrideQuery) {

    const searchInputEl = document.getElementById("searchInput");
    const query = overrideQuery !== undefined ? overrideQuery : searchInputEl.value.trim();

    if (!query) return;

    if (overrideQuery !== undefined) {
        searchInputEl.value = query;
        updateSearchGhost();
    }

    searchInputEl.blur();

    const libraryType = librarySearchShortcuts[query.toLowerCase()];

    if (libraryType) {
        browseLibrary(libraryType);
        return;
    }

    homeOverlayActive = false;
    resetLoadMoreState();

    const signal = beginAbortableLoad();

    try {

        const results = await api.search(query, signal);

        endAbortableLoad();
        recordView({ type: "search", query });
        setOverlayLocation("");
        showSearchOverlay();
        renderResults(results);

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return;

        showSearchOverlay();
        document.getElementById("searchResults").innerText = "Erreur de recherche";
        console.log(e);
    }

}

// "Charger plus" leaves the webplayer's cursor at the center of the
// list - if a tap misses (virtualized out) and the server has to go
// looking for it, this tells it which half of the loaded list (and
// so which direction from center) the track was in
function getDirectionHint(id) {

    const index = accumulatedTracks.findIndex(track => track.id === id);

    if (index === -1) return undefined;

    return index < accumulatedTracks.length / 2 ? "up" : "down";

}

export async function playResult(id) {

    await api.playResult(id, getDirectionHint(id));

    document.getElementById("searchResults").innerHTML = "";
    document.getElementById("searchInput").value = "";
    updateSearchGhost();
    hideSearchOverlay();
    resetLoadMoreState();
    resetNavigationHistory();
    setOverlayLocation("");
    coverTappedForCurrentAlbum = false;

    updateState();

}

export async function browseArtist(id, fallbackCover, title) {

    const direction = getDirectionHint(id);

    homeOverlayActive = false;
    resetLoadMoreState();

    const signal = beginAbortableLoad();

    try {

        let shown = false;

        await api.getArtist(id, signal, direction, (chunk) => {
            applyFallbackCovers(chunk.albums, fallbackCover);
            applyFallbackCovers(chunk.singles, fallbackCover);
            applyFallbackCovers(chunk.compilations, fallbackCover);
            if (!shown) {
                stopTypingAnimation();
                recordView({ type: "artist", id, cover: fallbackCover, title });
                setOverlayLocation(title);
                showSearchOverlay();
                shown = true;
            }
            renderArtistDiscography(chunk.albums, chunk.singles, chunk.compilations);
        });

        endAbortableLoad();

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return;

        showSearchOverlay();
        document.getElementById("searchResults").innerText = "Erreur";
        console.log(e);
    }

}

export async function browseAlbum(id, fallbackCover, title) {

    const direction = getDirectionHint(id);

    homeOverlayActive = false;
    resetLoadMoreState();

    const signal = beginAbortableLoad();

    try {

        const results = await api.getAlbum(id, signal, direction);

        applyFallbackCovers(results, fallbackCover);

        endAbortableLoad();
        recordView({ type: "album", id, cover: fallbackCover, title });
        setOverlayLocation(title);
        showSearchOverlay();
        renderResults(results);

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return;

        showSearchOverlay();
        document.getElementById("searchResults").innerText = "Erreur";
        console.log(e);
    }

}

export async function browsePlaylist(id, fallbackCover, title) {

    const direction = getDirectionHint(id);

    resetLoadMoreState();
    homeOverlayActive = false;

    const signal = beginAbortableLoad();

    try {

        const data = await api.getPlaylist(id, signal, direction);

        applyFallbackCovers(data.tracks, fallbackCover);

        endAbortableLoad();
        recordView({ type: "playlist", id, cover: fallbackCover, title });
        setOverlayLocation(title);
        showSearchOverlay();
        resetAccumulated(data.tracks);

        if (!data.atBottom) {
            playlistLoadMoreFallbackCover = fallbackCover || "";
            showLoadMoreButton(loadMorePlaylistTracks);
        }

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return;

        showSearchOverlay();
        document.getElementById("searchResults").innerText = "Erreur";
        console.log(e);
    }

}

const libraryTypeLabels = { playlists: "Playlists", artists: "Artistes", albums: "Albums" };

export async function browseLibrary(type) {

    resetLoadMoreState();
    homeOverlayActive = false;

    const signal = beginAbortableLoad();

    try {

        // exiting a folder if the sidebar happens to be sitting inside
        // one is handled server-side (selectLibraryChip checks for the
        // real Retour button itself), so nothing to do about that here
        const data = await api.getLibrary(type, signal);

        endAbortableLoad();
        recordView({ type: "library", libType: type });
        setOverlayLocation(libraryTypeLabels[type]);
        showSearchOverlay();
        resetAccumulated(data.tracks);

        if (!data.atBottom) {
            libraryLoadMoreType = type;
            showLoadMoreButton(loadMoreLibraryTracks);
        }

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return;

        showSearchOverlay();
        document.getElementById("searchResults").innerText = "Erreur";
        console.log(e);
    }

}

export async function browseLibraryFolder(id, title) {

    const direction = getDirectionHint(id);

    homeOverlayActive = false;
    resetLoadMoreState();

    const signal = beginAbortableLoad();

    try {

        const results = await api.getLibraryFolder(id, signal, direction);

        endAbortableLoad();
        recordView({ type: "libraryFolder", id, title });
        setOverlayLocation(title);
        showSearchOverlay();
        renderResults(results);

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return;

        showSearchOverlay();
        document.getElementById("searchResults").innerText = "Erreur";
        console.log(e);
    }

}

export async function browseCurrentArtist() {

    homeOverlayActive = false;
    resetLoadMoreState();

    // captured now (reflects the artist being browsed into), but only
    // shown later alongside the results themselves
    const artistName = document.getElementById("artistText").innerText;

    const fallbackCover = document.getElementById("cover").src;

    const signal = beginAbortableLoad();

    try {

        let shown = false;

        await api.getCurrentArtist(signal, (chunk) => {
            applyFallbackCovers(chunk.albums, fallbackCover);
            applyFallbackCovers(chunk.singles, fallbackCover);
            applyFallbackCovers(chunk.compilations, fallbackCover);
            if (!shown) {
                stopTypingAnimation();
                recordView({ type: "currentArtist" });
                setOverlayLocation(artistName);
                showSearchOverlay();
                shown = true;
            }
            renderArtistDiscography(chunk.albums, chunk.singles, chunk.compilations);
        });

        endAbortableLoad();

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return;

        showSearchOverlay();
        document.getElementById("searchResults").innerText = "Erreur";
        console.log(e);
    }

}

export async function writeAlbumNameToSearch() {

    try {

        const data = await api.getCurrentAlbumName();

        const searchInputEl = document.getElementById("searchInput");
        searchInputEl.value = data.name;
        updateSearchGhost();

    }
    catch (e) {
        console.log(e);
    }

}

export function handleCoverTap() {

    writeAlbumNameToSearch();

    if (coverTappedForCurrentAlbum) {
        browseCurrentAlbum();
    } else {
        coverTappedForCurrentAlbum = true;
    }

}

export async function browseCurrentAlbum() {

    if (currentAbortController) return;

    homeOverlayActive = false;
    resetLoadMoreState();
    // the first tap already fetched and wrote the album name into the
    // search input via writeAlbumNameToSearch(), so it's already there -
    // captured now, shown later alongside the results
    const albumName = document.getElementById("searchInput").value;

    const fallbackCover = document.getElementById("cover").src;

    const signal = beginAbortableLoad();

    try {

        const results = await api.getCurrentAlbum(signal);

        applyFallbackCovers(results, fallbackCover);

        endAbortableLoad();
        recordView({ type: "currentAlbum" });
        setOverlayLocation(albumName);
        showSearchOverlay();
        renderResults(results);

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return;

        showSearchOverlay();
        document.getElementById("searchResults").innerText = "Erreur";
        console.log(e);
    }

}

export async function browseHome() {

    if (currentAbortController) return;

    const overlayOpen = document.getElementById("searchOverlay").classList.contains("open");

    if (overlayOpen && homeOverlayActive) {
        closeSearch();
        return;
    }

    resetLoadMoreState();

    const signal = beginAbortableLoad();

    try {

        const sections = await api.getHome(signal);

        endAbortableLoad();
        recordView({ type: "home" });
        setOverlayLocation("");
        showSearchOverlay();
        renderSections(sections);
        homeOverlayActive = true;

    }
    catch (e) {
        endAbortableLoad();

        if (e.name === "AbortError") return;

        showSearchOverlay();
        document.getElementById("searchResults").innerText = "Erreur";
        console.log(e);
    }

}

export function closeSearch() {

    document.getElementById("searchResults").innerHTML = "";
    hideSearchOverlay();
    resetLoadMoreState();
    resetNavigationHistory();
    setOverlayLocation("");
    homeOverlayActive = false;
    coverTappedForCurrentAlbum = false;

    const searchInputEl = document.getElementById("searchInput");
    searchInputEl.value = "";
    searchInputEl.blur();
    updateSearchGhost();

}

export async function commitSeek() {

    const seekbar = document.getElementById("seekbar");
    const percent = seekbar.value / 1000;

    await api.seek(percent);

    seeking = false;

    updateState();

}

export async function cmd(action) {
    await api.sendCommand(action);
    updateState();
}

let pollInterval = null;

export function startPolling() {
    if (pollInterval) return;
    updateState();
    pollInterval = setInterval(() => {
        // none of what /state drives (play/pause, marquee, progress
        // bar, cover) is visible while the overlay covers the player
        // view - hideSearchOverlay() triggers a catch-up refresh as
        // soon as it closes, so nothing is missed in the meantime
        if (document.getElementById("searchOverlay").classList.contains("open")) return;
        updateState();
    }, 2000);
}

export function stopPolling() {
    clearInterval(pollInterval);
    pollInterval = null;
}
