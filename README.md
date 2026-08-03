# Spotify Remote

A phone-facing web remote for controlling Spotify running in a desktop browser: play/pause, skip, search, browse your library, artists, albums and playlists, all from a page you open on your phone.

## Disclaimer

This is a personal project, **not affiliated with or endorsed by Spotify**. It works by remote-controlling an already-logged-in Chromium tab running Spotify's own Web Player (via the Chrome DevTools Protocol), reading and clicking through its page like a human would, plus sending standard media-key commands over D-Bus/MPRIS. It does not use any private or official Spotify API, and it very likely falls outside Spotify's Terms of Service for automated access to their client.

Use at your own risk. There is no warranty (see [LICENSE](./LICENSE)), and Spotify could change their web player's markup at any time and break parts of this without notice.

Note also that this only *controls* playback — the audio itself plays wherever Chromium is running (your desktop's speakers/output). Getting that audio onto your phone, if you want that, is a separate concern this project doesn't handle.

## How it works

- `server.js` connects to a running Chromium instance over CDP (`chromium.connectOverCDP`) and drives the already-open Spotify Web Player tab with Playwright: reading the DOM to scrape your library/playlists/artists/albums, and clicking through the UI to navigate and search.
- Transport commands (play/pause/next/previous) go straight to Chromium's MPRIS interface over D-Bus instead of clicking DOM buttons, for reliability.
- A small static frontend (`public/`) is served by the same Express app and is meant to be opened from your phone's browser, on the same local network as the machine running the server.

**Language dependency**: some of the scraping logic matches specific French UI labels Spotify renders (e.g. "Discographie", "À suivre", "Titres likés"), because the author's own Spotify account is set to French. If your Spotify Web Player is in a different language, some features will silently fail to find what they're looking for. Adapting the string matches in `server.js` to another language should be straightforward if you want to try.

## Scope & design choices

This remote doesn't try to reproduce the full Spotify Web Player experience — navigation is intentionally simplified, especially around search, which is how the author mostly uses Spotify day to day. Some flows are reduced to whatever felt most relevant on a phone screen rather than mirroring every option the desktop/web client offers, so a few things you're used to in the real Spotify client may behave differently here, or not exist at all.

## Requirements

- Linux with D-Bus available (`gdbus` on your `PATH`) — used for MPRIS transport commands.
- [Node.js](https://nodejs.org/) 18+.
- Chromium or Google Chrome, launched with remote debugging enabled and already logged into [open.spotify.com](https://open.spotify.com):

  ```
  chromium --remote-debugging-port=9222 --app=https://open.spotify.com
  ```

## Setup

```bash
git clone <this repo>
cd spotify-remote
npm install
```

Optionally copy `.env.example` to `.env` and fill in anything that applies to your account (see the file for details — everything in it is an optional workaround for account-specific quirks).

Start Chromium as shown above and log into Spotify, then:

```bash
node server.js
```

Open `http://<machine-ip>:3000` from your phone, on the same network.

## License

MIT — see [LICENSE](./LICENSE).
