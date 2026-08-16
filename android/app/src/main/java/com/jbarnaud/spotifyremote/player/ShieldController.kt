package com.jbarnaud.spotifyremote.player

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

// Mirrors player.js's armShield/armShieldAt exactly - see server.js's
// /play and /pause routes for why the two shapes below are NOT
// interchangeable with a naive "disable while a request is in flight".
//
// /play (resumeHlsEncoder) has no cancellation guard server-side: a
// /pause landing anywhere during the wait still results in the encoder
// being un-paused once the wait ends regardless, silently streaming
// captured silence. The WHOLE window is dangerous, not just its tail -
// armWholeDuration blocks the whole thing immediately.
//
// /pause is mostly safely interruptible server-side (a /play mid-wait
// cleanly cancels the pending pause via a generation counter) - only
// the final kill+pause handoff at the very end (well under 100ms) is
// unsafe. armBracketed schedules a short disable window to bracket just
// that instant, leaving the control tappable (and a pending pause
// cleanly cancellable) for the rest of the wait.
//
// resumeHlsEncoder's gapless-on-resume trick (see its own comment in
// server.js) depends on this phone having already buffered the 2 extra
// segments the pause wait produced, so a fresh instance's short
// spawn+inputReady window can be bridged locally. Those segments only
// finish existing right as the pause lands, so tapping play the
// instant the bracket clears gives no margin to have actually
// fetched/buffered them yet - cooldownMs keeps the control shielded a
// bit longer after landing, purely to let that catch up. It does not
// change the mid-wait cancel behavior at all.
class ShieldController(private val scope: CoroutineScope) {

    private val _isShielded = MutableStateFlow(false)
    val isShielded: StateFlow<Boolean> = _isShielded.asStateFlow()

    private var job: Job? = null

    fun armWholeDuration(ms: Long) {
        job?.cancel()
        if (ms <= 0) {
            _isShielded.value = false
            return
        }
        _isShielded.value = true
        job = scope.launch {
            delay(ms)
            _isShielded.value = false
        }
    }

    fun armBracketed(landsInMs: Long, leadMs: Long = 300, tailMs: Long = 100, cooldownMs: Long = 2000) {
        job?.cancel()
        _isShielded.value = false
        if (landsInMs <= 0) return
        job = scope.launch {
            delay((landsInMs - leadMs).coerceAtLeast(0))
            _isShielded.value = true
            delay(leadMs + tailMs + cooldownMs)
            _isShielded.value = false
        }
    }

}
