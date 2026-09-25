package com.faceclaw.app

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.graphics.Bitmap
import android.media.AudioManager
import android.media.MediaDescription
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log

import org.json.JSONArray
import org.json.JSONObject

import java.util.HashSet

class FaceclawMediaController(context: Context) {
    companion object {
        private const val ENABLED_NOTIFICATION_LISTENERS = "enabled_notification_listeners"
    }

    private val appContext: Context = context.applicationContext
    private val lock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val listenerComponent: ComponentName
    private val sessionManager: MediaSessionManager?
    private val audioManager: AudioManager?

    private val controllerCallback: MediaController.Callback = object : MediaController.Callback() {
        override fun onPlaybackStateChanged(state: PlaybackState?) {
            synchronized(lock) {
                emitStateLocked()
            }
        }

        override fun onMetadataChanged(metadata: MediaMetadata?) {
            synchronized(lock) {
                emitStateLocked()
            }
        }

        override fun onQueueChanged(queue: MutableList<MediaSession.QueueItem>?) {
            synchronized(lock) {
                emitStateLocked()
            }
        }

        override fun onSessionDestroyed() {
            synchronized(lock) {
                refreshActiveControllerLocked(null)
            }
        }
    }

    private val sessionsChangedListener = MediaSessionManager.OnActiveSessionsChangedListener { controllers ->
        synchronized(lock) {
            refreshActiveControllerLocked(controllers)
        }
    }

    /**
     * Fires when the user grants or revokes notification-listener access in
     * system settings. Session access depends on that grant, so the sessions
     * listener is (re)registered and the state re-emitted whenever it changes;
     * otherwise a grant made after start() would never be noticed.
     */
    private val notificationAccessObserver: ContentObserver = object : ContentObserver(mainHandler) {
        override fun onChange(selfChange: Boolean) {
            synchronized(lock) {
                if (!started) return
                syncSessionsListenerLocked()
                refreshActiveControllerLocked(null)
            }
        }
    }

    @Volatile
    private var listener: FaceclawMediaControllerListener? = null
    private var activeController: MediaController? = null
    private var started = false
    private var sessionsListenerRegistered = false
    private var ignoredPackages: Set<String> = HashSet()

    init {
        this.listenerComponent = ComponentName(appContext, FaceclawMediaNotificationListenerService::class.java)
        this.sessionManager = appContext.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager?
        this.audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager?
    }

    fun setListener(listener: FaceclawMediaControllerListener?) {
        synchronized(lock) {
            this.listener = listener
            emitStateLocked()
        }
    }

    fun start() {
        synchronized(lock) {
            if (started) {
                emitStateLocked()
                return
            }
            started = true
            try {
                appContext.contentResolver.registerContentObserver(
                    Settings.Secure.getUriFor(ENABLED_NOTIFICATION_LISTENERS),
                    false,
                    notificationAccessObserver
                )
            } catch (e: Exception) {
                Log.w("FaceclawMedia", "notification access observer registration failed", e)
            }
            syncSessionsListenerLocked()
            refreshActiveControllerLocked(null)
        }
    }

    /**
     * Keep the active-sessions listener registered exactly while notification
     * access is granted. Registration throws SecurityException without the
     * grant, so this is retried from the settings observer rather than only
     * attempted once at start().
     */
    private fun syncSessionsListenerLocked() {
        if (sessionManager == null) return
        val accessEnabled = started && isNotificationAccessEnabled()
        if (accessEnabled && !sessionsListenerRegistered) {
            try {
                sessionManager.addOnActiveSessionsChangedListener(
                    sessionsChangedListener,
                    listenerComponent,
                    mainHandler
                )
                sessionsListenerRegistered = true
            } catch (ignored: SecurityException) {
            }
        } else if (!accessEnabled && sessionsListenerRegistered) {
            try {
                sessionManager.removeOnActiveSessionsChangedListener(sessionsChangedListener)
            } catch (ignored: SecurityException) {
            }
            sessionsListenerRegistered = false
        }
    }

    /** Apply the complete preference set and immediately choose an allowed session. */
    fun setIgnoredPackagesJson(packagesJson: String?) {
        val packages: MutableSet<String> = HashSet()
        try {
            val array = JSONArray(packagesJson)
            for (i in 0 until array.length()) packages.add(array.getString(i))
        } catch (e: Exception) {
            Log.w("FaceclawMedia", "invalid ignored packages", e)
            return
        }
        synchronized(lock) {
            if (ignoredPackages == packages) return
            ignoredPackages = packages
            refreshActiveControllerLocked(null)
        }
    }

    fun stop() {
        synchronized(lock) {
            if (!started) {
                return
            }
            started = false
            try {
                appContext.contentResolver.unregisterContentObserver(notificationAccessObserver)
            } catch (ignored: Exception) {
            }
            syncSessionsListenerLocked()
            setActiveControllerLocked(null)
            emitStateLocked()
        }
    }

    fun playPause() {
        synchronized(lock) {
            val controller = activeController
            if (controller == null) {
                return
            }
            val playbackState: PlaybackState? = controller.playbackState
            val controls: MediaController.TransportControls = controller.transportControls
            if (playbackState == null) {
                controls.play()
                return
            }
            when (playbackState.state) {
                PlaybackState.STATE_PLAYING,
                PlaybackState.STATE_BUFFERING,
                PlaybackState.STATE_CONNECTING -> {
                    controls.pause()
                    return
                }
                else -> controls.play()
            }
        }
    }

    fun skipNext() {
        synchronized(lock) {
            val controller = activeController
            if (controller != null) {
                controller.transportControls.skipToNext()
            }
        }
    }

    fun skipPrevious() {
        synchronized(lock) {
            val controller = activeController
            if (controller != null) {
                controller.transportControls.skipToPrevious()
            }
        }
    }

    fun skipToQueueItem(queueId: Long) {
        synchronized(lock) {
            val controller = activeController
            if (controller != null) {
                controller.transportControls.skipToQueueItem(queueId)
            }
        }
    }

    /** Current phone media-stream volume normalized to the range 0..100. */
    fun getMediaVolumePercent(): Int {
        if (audioManager == null) {
            return -1
        }
        val maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        if (maxVolume <= 0) {
            return 0
        }
        val currentVolume = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
        return Math.max(0, Math.min(100, Math.round(currentVolume * 100f / maxVolume)))
    }

    /** Set the phone media-stream volume from a normalized 0..100 value. */
    fun setMediaVolumePercent(volumePercent: Int) {
        if (audioManager == null) {
            return
        }
        val clampedPercent = Math.max(0, Math.min(100, volumePercent))
        val maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val streamVolume = Math.round(clampedPercent * maxVolume / 100f)
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, streamVolume, 0)
    }

    /**
     * Album art for the active session's current item, grayscale, scaled to
     * fit within maxSize x maxSize preserving aspect. Returns a gray packet
     * (see ImageFileLoader.bitmapToGrayPacket) or an empty array when no art
     * is available. gamma and dither are the photographic tone handling
     * described on ImageFileLoader.bitmapToGrayPacket; the TS side passes
     * its shared photo preset.
     */
    fun getAlbumArtGray(maxSize: Int, gamma: Float, dither: Boolean): ByteArray {
        var art: Bitmap?
        synchronized(lock) {
            val controller = activeController
            if (controller == null) {
                return ByteArray(0)
            }
            val metadata: MediaMetadata? = controller.metadata
            if (metadata == null) {
                return ByteArray(0)
            }
            art = metadata.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)
            if (art == null) {
                art = metadata.getBitmap(MediaMetadata.METADATA_KEY_ART)
            }
            if (art == null) {
                art = metadata.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON)
            }
        }
        return ImageFileLoader.bitmapToGrayPacket(art, maxSize, maxSize, gamma, dither)
    }

    /**
     * The active session's queue (playlist) as JSON:
     * [{"id": long, "title": string, "active": bool}, ...]. Empty string when
     * the player exposes no queue.
     */
    fun getQueueJson(): String {
        synchronized(lock) {
            val controller = activeController
            if (controller == null) {
                return ""
            }
            val queue: List<MediaSession.QueueItem>? = controller.queue
            if (queue == null || queue.isEmpty()) {
                return ""
            }
            val state: PlaybackState? = controller.playbackState
            val activeId = if (state == null) -1L else state.activeQueueItemId
            try {
                val out = JSONArray()
                for (item in queue) {
                    val description: MediaDescription? = item.description
                    val title: CharSequence? = if (description == null) null else description.title
                    val entry = JSONObject()
                    entry.put("id", item.queueId)
                    entry.put("title", if (title == null) "" else title.toString())
                    entry.put("active", item.queueId == activeId)
                    out.put(entry)
                }
                return out.toString()
            } catch (e: Exception) {
                Log.w("FaceclawMedia", "queue serialization failed", e)
                return ""
            }
        }
    }

    fun openNotificationAccessSettings() {
        val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        appContext.startActivity(intent)
    }

    private fun refreshActiveControllerLocked(controllersIn: List<MediaController>?) {
        var controllers = controllersIn
        if (!started) {
            setActiveControllerLocked(null)
            emitStateLocked()
            return
        }
        if (!isNotificationAccessEnabled()) {
            setActiveControllerLocked(null)
            emitStateLocked()
            return
        }
        if (controllers == null && sessionManager != null) {
            try {
                controllers = sessionManager.getActiveSessions(listenerComponent)
            } catch (ignored: SecurityException) {
                controllers = null
            }
        }
        emitSessionAppsLocked(controllers)
        setActiveControllerLocked(chooseController(controllers))
        emitStateLocked()
    }

    private fun chooseController(controllers: List<MediaController>?): MediaController? {
        if (controllers == null || controllers.isEmpty()) {
            return null
        }
        var first: MediaController? = null
        for (controller in controllers) {
            if (ignoredPackages.contains(controller.packageName)) continue
            if (first == null) first = controller
            val playbackState: PlaybackState? = controller.playbackState
            if (playbackState != null && playbackState.state == PlaybackState.STATE_PLAYING) {
                return controller
            }
        }
        return first
    }

    private fun emitSessionAppsLocked(controllers: List<MediaController>?) {
        val currentListener = listener
        if (currentListener == null || controllers == null) return
        val apps = JSONArray()
        val seen: MutableSet<String> = HashSet()
        for (controller in controllers) {
            val packageName = safe(controller.packageName)
            if (packageName.isEmpty() || !seen.add(packageName)) continue
            try {
                val app = JSONObject()
                app.put("packageName", packageName)
                app.put("appName", getApplicationLabel(packageName))
                apps.put(app)
            } catch (e: Exception) {
                Log.w("FaceclawMedia", "session app serialization failed", e)
            }
        }
        val json = apps.toString()
        mainHandler.post { currentListener.onSessionAppsChanged(json) }
    }

    private fun setActiveControllerLocked(controller: MediaController?) {
        if (sameController(activeController, controller)) {
            return
        }
        val previous = activeController
        if (previous != null) {
            previous.unregisterCallback(controllerCallback)
        }
        activeController = controller
        if (controller != null) {
            controller.registerCallback(controllerCallback, mainHandler)
        }
    }

    private fun sameController(a: MediaController?, b: MediaController?): Boolean {
        if (a === b) {
            return true
        }
        if (a == null || b == null) {
            return false
        }
        return a.sessionToken == b.sessionToken
    }

    private fun isNotificationAccessEnabled(): Boolean {
        val enabledListeners: String? = Settings.Secure.getString(
            appContext.contentResolver,
            ENABLED_NOTIFICATION_LISTENERS
        )
        if (enabledListeners == null || enabledListeners.isEmpty()) {
            return false
        }
        val fullName = listenerComponent.flattenToString()
        val shortName = listenerComponent.flattenToShortString()
        return enabledListeners.contains(fullName)
            || enabledListeners.contains(shortName)
            || enabledListeners.contains(appContext.packageName)
    }

    private fun emitStateLocked() {
        val currentListener = listener
        if (currentListener == null) {
            return
        }

        var playbackState = if (started) "idle" else "stopped"
        var packageName = ""
        var appName = ""
        var title = ""
        var artist = ""
        var album = ""
        var positionMs = -1L
        var durationMs = -1L
        var playbackSpeed = 0f
        var canPlayPause = false
        var canSkipNext = false
        var canSkipPrevious = false
        val accessEnabled = isNotificationAccessEnabled()
        val status: String

        val controller = activeController
        if (!accessEnabled) {
            playbackState = "notification-access-required"
            status = "Notification access required."
        } else if (controller == null) {
            status = "No active media session."
        } else {
            packageName = safe(controller.packageName)
            appName = getApplicationLabel(packageName)
            val state: PlaybackState? = controller.playbackState
            val metadata: MediaMetadata? = controller.metadata
            playbackState = playbackStateName(state)
            if (metadata != null) {
                title = safe(metadata.getString(MediaMetadata.METADATA_KEY_TITLE))
                artist = safe(metadata.getString(MediaMetadata.METADATA_KEY_ARTIST))
                album = safe(metadata.getString(MediaMetadata.METADATA_KEY_ALBUM))
                durationMs = metadata.getLong(MediaMetadata.METADATA_KEY_DURATION)
                if (durationMs <= 0L) {
                    durationMs = -1L
                }
            }
            if (state != null) {
                positionMs = estimatedPositionMs(state, durationMs)
                playbackSpeed = state.playbackSpeed
            }
            val actions = if (state == null) 0L else state.actions
            canPlayPause = (actions and PlaybackState.ACTION_PLAY_PAUSE) != 0L
                || (actions and PlaybackState.ACTION_PLAY) != 0L
                || (actions and PlaybackState.ACTION_PAUSE) != 0L
            canSkipNext = (actions and PlaybackState.ACTION_SKIP_TO_NEXT) != 0L
            canSkipPrevious = (actions and PlaybackState.ACTION_SKIP_TO_PREVIOUS) != 0L
            status = if (packageName.isEmpty()) "Active media session." else "Active session: $packageName"
        }

        val finalPlaybackState = playbackState
        val finalPackageName = packageName
        val finalAppName = appName
        val finalTitle = title
        val finalArtist = artist
        val finalAlbum = album
        val finalPositionMs = positionMs
        val finalDurationMs = durationMs
        val finalPlaybackSpeed = playbackSpeed
        val finalCanPlayPause = canPlayPause
        val finalCanSkipNext = canSkipNext
        val finalCanSkipPrevious = canSkipPrevious
        val finalAccessEnabled = accessEnabled
        val finalStatus = status

        mainHandler.post {
            currentListener.onStateChange(
                finalPlaybackState,
                finalPackageName,
                finalAppName,
                finalTitle,
                finalArtist,
                finalAlbum,
                finalPositionMs,
                finalDurationMs,
                finalPlaybackSpeed,
                finalCanPlayPause,
                finalCanSkipNext,
                finalCanSkipPrevious,
                finalAccessEnabled,
                finalStatus
            )
        }
    }

    private fun playbackStateName(state: PlaybackState?): String {
        if (state == null) {
            return "idle"
        }
        return when (state.state) {
            PlaybackState.STATE_PLAYING -> "playing"
            PlaybackState.STATE_PAUSED -> "paused"
            PlaybackState.STATE_BUFFERING,
            PlaybackState.STATE_CONNECTING -> "buffering"
            PlaybackState.STATE_STOPPED -> "stopped"
            else -> "idle"
        }
    }

    /** PlaybackState positions are snapshots; advance a playing snapshot to now. */
    private fun estimatedPositionMs(state: PlaybackState, durationMs: Long): Long {
        var positionMs = state.position
        if (positionMs == PlaybackState.PLAYBACK_POSITION_UNKNOWN) {
            return -1L
        }
        if (state.state == PlaybackState.STATE_PLAYING) {
            val updatedAtMs = state.lastPositionUpdateTime
            if (updatedAtMs > 0L) {
                positionMs += ((SystemClock.elapsedRealtime() - updatedAtMs) * state.playbackSpeed).toLong()
            }
        }
        positionMs = Math.max(0L, positionMs)
        return if (durationMs > 0L) Math.min(positionMs, durationMs) else positionMs
    }

    /** Resolve a media session's package id to the user-facing installed app name. */
    private fun getApplicationLabel(packageName: String?): String {
        if (packageName == null || packageName.isEmpty()) {
            return ""
        }
        val packageManager = appContext.packageManager
        try {
            val applicationInfo: ApplicationInfo = packageManager.getApplicationInfo(packageName, 0)
            val label: CharSequence? = packageManager.getApplicationLabel(applicationInfo)
            if (label != null && label.length > 0) {
                return label.toString()
            }
        } catch (ignored: PackageManager.NameNotFoundException) {
        }
        return packageName
    }

    private fun safe(value: String?): String {
        return value ?: ""
    }
}
