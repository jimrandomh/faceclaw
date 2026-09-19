package com.faceclaw.app

interface FaceclawMediaControllerListener {
    /** All observed session owners, before filtering or choosing the active player. */
    fun onSessionAppsChanged(appsJson: String?): Unit

    fun onStateChange(
        playbackState: String?,
        packageName: String?,
        appName: String?,
        title: String?,
        artist: String?,
        album: String?,
        positionMs: Long,
        durationMs: Long,
        playbackSpeed: Float,
        canPlayPause: Boolean,
        canSkipNext: Boolean,
        canSkipPrevious: Boolean,
        accessEnabled: Boolean,
        status: String?,
    ): Unit
}
