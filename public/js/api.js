export async function sendCommand(action) {
    return fetch("/" + action);
}

export async function getState() {
    const res = await fetch("/state");
    return res.json();
}

export async function getContextAndQueue() {
    const res = await fetch("/context-and-queue");
    return res.json();
}

export async function playQueueItem(index, listType) {
    return fetch("/queue-play?index=" + index + (listType ? "&list=" + listType : ""));
}

export async function queueRemove(index, listType) {
    return fetch("/queue-remove?index=" + index + "&list=" + listType);
}

export async function search(query, signal) {
    const res = await fetch("/search?q=" + encodeURIComponent(query), { signal });
    return res.json();
}

export async function playResult(id, direction) {
    return fetch("/play-result?id=" + id + (direction ? "&direction=" + direction : ""));
}

export async function queueAdd(id, direction) {
    return fetch("/queue-add?id=" + id + (direction ? "&direction=" + direction : ""));
}

export async function getArtist(id, signal, direction, onChunk) {
    return streamNdjson("/artist?id=" + id + (direction ? "&direction=" + direction : ""), signal, onChunk);
}

export async function getAlbum(id, signal, direction) {
    const res = await fetch("/album?id=" + id + (direction ? "&direction=" + direction : ""), { signal });
    return res.json();
}

export async function getPlaylist(id, signal, direction) {
    const res = await fetch("/playlist?id=" + id + (direction ? "&direction=" + direction : ""), { signal });
    return res.json();
}

async function streamNdjson(url, signal, onChunk) {

    const res = await fetch(url, { signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    while (true) {

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
            if (line.trim()) onChunk(JSON.parse(line));
        }

    }

    if (buffer.trim()) onChunk(JSON.parse(buffer));

}

export async function getPlaylistMore(signal, onChunk) {
    return streamNdjson("/playlist-more", signal, onChunk);
}

export async function getWhatsNew(signal) {
    const res = await fetch("/whats-new", { signal });
    return res.json();
}

export async function getLibrary(type, signal) {
    const res = await fetch("/library?type=" + type, { signal });
    return res.json();
}

export async function getLibraryMore(type, signal, onChunk) {
    return streamNdjson("/library-more?type=" + type, signal, onChunk);
}

export async function getLibraryFolder(id, signal, direction) {
    const res = await fetch("/library-folder?id=" + id + (direction ? "&direction=" + direction : ""), { signal });
    return res.json();
}

export async function getLibraryBack(exitFolder, signal) {
    const res = await fetch("/library-back" + (exitFolder ? "?exitFolder=1" : ""), { signal });
    return res.json();
}

export async function getHome(signal) {
    const res = await fetch("/home", { signal });
    return res.json();
}

export async function getHomeSection(index, signal) {
    const res = await fetch("/home-section?index=" + index, { signal });
    return res.json();
}

export async function getCurrentArtist(signal, onChunk) {
    return streamNdjson("/current-artist", signal, onChunk);
}

export async function getCurrentAlbumName() {
    const res = await fetch("/current-album-name");
    return res.json();
}

export async function getCurrentAlbum(signal) {
    const res = await fetch("/current-album", { signal });
    return res.json();
}

export async function seek(percent) {
    return fetch("/seek?percent=" + percent);
}
