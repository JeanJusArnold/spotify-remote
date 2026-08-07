#!/bin/bash
# Mirrors AudioRelay's own connect/disconnect events (read from its log)
# to Spotify's play/pause, so pausing/resuming AudioRelay's transmission
# (its free-tier stop/start button, or its premium notification
# play/pause, which is the one that's confirmed to actually disconnect
# rather than just mute locally) also pauses/resumes Spotify.
#
# This only works one-way (AudioRelay -> Spotify) - using the remote's
# own play/pause doesn't do anything to AudioRelay's connection in return.

LOG="$HOME/.var/app/net.audiorelay.AudioRelay/cache/audiorelay/logs/audiorelay.log"

# Going through the remote's own /play and /pause instead of calling
# MPRIS directly matters right after a fresh Chromium/tab launch: MPRIS
# isn't registered at all until the page has played once via a real user
# gesture (autoplay policy), so a direct gdbus call here would just fail
# silently until someone clicks play by hand once. /play and /pause
# already fall back to a real Playwright click on Spotify's own button
# when MPRIS isn't there, same as a mouse click would do.
send_command() {
    local endpoint="$1"
    echo "$(date +%T) -> $endpoint"
    curl -s -o /dev/null "http://127.0.0.1:3000/$endpoint"
}

# -F retries until the log file exists, so this doesn't need to wait for
# AudioRelay to have started and logged something first
tail -F -n0 "$LOG" 2>/dev/null | while read -r line; do
    case "$line" in
        *"Remote device disconnected"*)
            send_command pause
            ;;
        *"Remote device connected"*)
            send_command play
            ;;
    esac
done
