package com.jbarnaud.spotifyremote.state

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import javax.inject.Inject
import javax.inject.Singleton

// Carries a raw shared-link string from MainActivity (ACTION_SEND's
// EXTRA_TEXT, or ACTION_VIEW's data URI) into AppViewModel, which owns
// the actual /resolve-link call and app-scoped navigation/snackbar
// state - MainActivity has no ViewModel-scoped state of its own and
// singleTask means both entry points (a fresh launch and onNewIntent on
// an already-running instance) need to reach the same place. Same
// shared-singleton-signal shape as QueueRefreshTrigger. replay = 1 (not
// just extraBufferCapacity) is load-bearing: on a cold start via a link
// tap/share, MainActivity.onCreate calls submit() synchronously before
// Compose even runs, let alone before AppViewModel's init{} coroutine
// gets scheduled to start collecting - confirmed live, the emission
// really does land before the collector attaches. extraBufferCapacity
// alone only smooths emit() for a slow *already-attached* subscriber, it
// does not replay to one that attaches later. Safe here specifically
// because there is exactly one long-lived subscriber (AppViewModel, for
// the app's whole process lifetime) - no risk of a stale link replaying
// into some later, unrelated collector.
@Singleton
class SharedLinkController @Inject constructor() {

    private val _links = MutableSharedFlow<String>(replay = 1)
    val links: SharedFlow<String> = _links.asSharedFlow()

    fun submit(rawLink: String) {
        _links.tryEmit(rawLink)
    }

}
