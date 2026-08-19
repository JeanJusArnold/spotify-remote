# Spotify Remote

A native Android app for controlling Spotify running in a desktop browser, from your phone: play/pause, skip, search, browse your library, artists, albums and playlists — plus streaming that desktop session's actual audio back to your phone. It comes with a recommended companion setup for a dedicated, resource-conscious desktop session too.

## Disclaimer

This is a personal project, **not affiliated with or endorsed by Spotify**. It works by remote-controlling an already-logged-in Chromium tab running Spotify's own Web Player (via the Chrome DevTools Protocol). It does not use any private or official Spotify API, and it very likely falls outside Spotify's Terms of Service for automated access to their client.

Use at your own risk. There is no warranty (see [LICENSE](./LICENSE)), and Spotify could change their web player's markup at any time and break parts of this without notice.

## Screenshots

<p>
<img src="screenshots/main.png" width="200" alt="Now-playing view with the queue">
<img src="screenshots/search.png" width="200" alt="Search results">
<img src="screenshots/album.png" width="200" alt="Album tracklist">
<img src="screenshots/home.png" width="200" alt="Home overlay with recommended sections">
</p>

(from the original web client, kept for reference — the native Android app follows the same screens with a native UI)

## How it works

- `server.js` connects to a running Chromium instance over CDP (`chromium.connectOverCDP`) and drives the already-open Spotify Web Player tab with Playwright: reading the DOM to scrape your library/playlists/artists/albums, and clicking through the UI to navigate and search.
- Transport commands (play/pause/next/previous) go straight to Chromium's MPRIS interface over D-Bus instead of clicking DOM buttons, for reliability.
- Getting that desktop session's audio onto your phone doesn't rely on a separate app: `server.js` captures a dedicated virtual audio sink itself, encodes it with `ffmpeg`, and rebroadcasts it live as a continuous AAC stream (Icecast/SHOUTcast-style — one connection per listener, no manifest) that the app plays natively with hardware decode.
- The Android app (`android/`) is the client this project is actually built and maintained around. An earlier web page (`public/`), also served by the same Express app, is still in the repo and still technically works, but it's no longer actively developed - the native app fully replaced it.

**No built-in authentication**: there's no password or login, so don't expose this to the public internet (e.g. don't port-forward it). Use a private network like Tailscale to reach it remotely instead — the app talks to the server over plain HTTP, relying on Tailscale's own WireGuard encryption rather than a TLS layer on top.

**Language dependency**: some of the scraping logic matches specific French UI labels Spotify renders (e.g. "Discographie", "À suivre", "Titres likés"), because the author's own Spotify account is set to French. If your Spotify Web Player is in a different language, some features will silently fail to find what they're looking for. Adapting the string matches in `server.js` to another language should be straightforward if you want to try.

## Scope & design choices

This remote doesn't try to reproduce the full Spotify Web Player experience — navigation is intentionally simplified, especially around search, which is how the author mostly uses Spotify day to day. Some flows are reduced to whatever felt most relevant on a phone screen rather than mirroring every option the desktop/web client offers, so a few things you're used to in the real Spotify client may behave differently here, or not exist at all.

## Requirements

- Linux with D-Bus available (`gdbus` on your `PATH`) — used for MPRIS transport commands.
- [Node.js](https://nodejs.org/) 18+.
- `ffmpeg` on your `PATH` — used to encode the audio relay.
- A PipeWire or PulseAudio virtual sink named `spotify-remote-audio` for `ffmpeg` to capture from — see `openbox-autostart.example` for how to create one automatically on session start.
- Chromium or Google Chrome, launched with remote debugging enabled and already logged into [open.spotify.com](https://open.spotify.com):

  ```
  chromium --remote-debugging-port=9222 --app=https://open.spotify.com --start-maximized
  ```

  Keep the window maximized (`--start-maximized` above does this on launch) — the scraping logic scrolls through however many items fit on screen, so a small window means more scrolling and slower scraping.

  Don't forget to install an ad blocker like [uBlock Origin](https://ublockorigin.com/) in this Chromium.

## Setup

```bash
git clone <this repo>
cd spotify-remote
./setup.sh
```

`setup.sh` walks through everything below interactively: checking/installing system requirements, creating the virtual audio sink, Tailscale, optionally EasyEffects (with the exact settings to enter), optionally the dedicated-session autostart file, then launching Chromium and the server. It only ever installs something after asking first, and it's safe to re-run — every step checks whether it's already done before acting. The rest of this section is what it automates, kept here for anyone who'd rather do it by hand or understand what the script is doing.

```bash
npm install
```

`openbox-autostart.example` documents a full recommended session setup (virtual audio sink, launching Chromium, and launching the server itself) as a copyable template for a dedicated session running just this project — copy it to `~/.config/openbox/autostart` (or let `setup.sh` generate it for you).

Optionally, [EasyEffects](https://github.com/wwmm/easyeffects) can sit between Chromium and the virtual sink to level out loudness differences between tracks. `openbox-autostart.example` has the details (install command, and the Auto Gain settings this project settled on).

If you set this dedicated session up, make sure your display manager doesn't boot straight into it. It's also not something you want live right after a cold boot, especially since a minimal session like this is more likely to fail to start cleanly than your main one. On GDM with autologin enabled, this is a real pitfall: it silently re-logs into whichever session was last selected at the greeter (tracked per-user by AccountsService), so picking the dedicated session there even once makes it the autologin target from then on. Pin your main session instead by writing it directly to `/var/lib/AccountsService/users/<username>` (e.g. `Session=gnome`, `SessionType=wayland`) so autologin always lands there regardless of what was last picked manually.

If you'd rather skip the dedicated-session setup entirely, three manual steps are all you actually need: launch Chromium with the command from the [Requirements](#requirements) section above, log into Spotify in it, then start the server:

```bash
node server.js
```

(The autostart script above does both of these automatically on login)

### Connecting the app

Build it from `android/` (`./gradlew assembleDebug`, or open the folder in Android Studio), install the APK on your phone, and enter the server's Tailscale hostname or IP in the app's Settings screen on first run (e.g. `http://<hostname>.<tailnet>.ts.net:3000` or `http://<tailscale-ip>:3000`). This is a one-time setting, editable later.

(The old web page under `public/` still loads at `http://<machine-ip>:3000` from a phone browser if you'd rather not install an APK, but it isn't maintained any more - expect the app above to be the better experience.)

## License

MIT — see [LICENSE](./LICENSE).
