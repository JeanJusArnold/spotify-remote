package com.jbarnaud.spotifyremote.state

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import javax.inject.Inject
import javax.inject.Singleton

// A play/pause tap (from NowPlayingViewModel's on-screen button, or from
// RemoteControlPlayer via the notification/lock screen) used to only
// ever reach the real ExoPlayer through the /state poll loop noticing
// the server's new value on its next tick - the tap itself only ever
// called the server API. That made the local player's own response
// entirely dependent on however often that loop happened to run, which
// is exactly what made it unsafe to slow the loop down while paused (or
// stop it while backgrounded) without also making the local player feel
// unresponsive or outright stuck. This is the second, independent
// signal PlaybackService also acts on immediately - same shape as
// QueueRefreshTrigger - so a tap moves the local player right away
// regardless of the poll loop's own cadence, which is what actually
// makes slowing that loop down safe.
@Singleton
class LocalPlaybackIntentTrigger @Inject constructor() {

    private val _events = MutableSharedFlow<Boolean>(extraBufferCapacity = 1)
    val events: SharedFlow<Boolean> = _events.asSharedFlow()

    fun requestPlaying(playing: Boolean) {
        _events.tryEmit(playing)
    }

}
