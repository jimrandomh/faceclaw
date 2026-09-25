package com.faceclaw.app

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.media.browse.MediaBrowser
import android.media.session.MediaController
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log

import org.json.JSONArray
import org.json.JSONObject

import java.util.ArrayList
import java.util.Collections

/**
 * Client for other apps' MediaBrowserService implementations (the mechanism
 * Android Auto uses). Binding starts the target player's process even when it
 * is not running, so this can list a player's library (playlists, albums, ...)
 * and start playback without the phone being unlocked.
 *
 * Holds at most one connection at a time. All MediaBrowser interaction happens
 * on the main thread; results are reported through
 * FaceclawMediaBrowserListener, also on the main thread.
 */
class FaceclawMediaBrowser(context: Context) {
    companion object {
        private const val TAG = "FaceclawMediaBrowser"
        private const val BROWSER_SERVICE_ACTION = "android.media.browse.MediaBrowserService"
        // Generous: connecting may cold-start the player's process.
        private const val CONNECT_TIMEOUT_MS = 15_000L
        private const val BROWSE_TIMEOUT_MS = 15_000L
        // Unbinding immediately after a play command can race the player promoting
        // itself to a foreground service, letting the system kill its process
        // before playback starts; keep the binding alive briefly instead.
        private const val PLAY_DISCONNECT_GRACE_MS = 5_000L
    }

    private val appContext: Context = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile
    private var listener: FaceclawMediaBrowserListener? = null

    // Main-thread only.
    private var browser: MediaBrowser? = null
    private var generation = 0
    private var lastPlayCommandAtMs = 0L

    fun setListener(listener: FaceclawMediaBrowserListener?) {
        this.listener = listener
    }

    /**
     * Installed apps exposing a media browser service, as JSON sorted by app
     * name: [{"packageName": ..., "serviceClass": ..., "appName": ...}, ...].
     * Synchronous (PackageManager lookup only).
     */
    fun listBrowsableAppsJson(): String {
        val packageManager = appContext.packageManager
        val services: List<ResolveInfo>
        try {
            services = packageManager.queryIntentServices(Intent(BROWSER_SERVICE_ACTION), 0)
        } catch (e: Exception) {
            Log.w(TAG, "media browser service query failed", e)
            return "[]"
        }
        val apps: MutableList<JSONObject> = ArrayList()
        for (service in services) {
            if (service.serviceInfo == null) {
                continue
            }
            try {
                val label: CharSequence? = service.serviceInfo.applicationInfo.loadLabel(packageManager)
                val app = JSONObject()
                app.put("packageName", service.serviceInfo.packageName)
                app.put("serviceClass", service.serviceInfo.name)
                app.put("appName", if (label == null) service.serviceInfo.packageName else label.toString())
                apps.add(app)
            } catch (e: Exception) {
                Log.w(TAG, "media browser service entry failed", e)
            }
        }
        Collections.sort(apps) { a, b -> a.optString("appName").compareTo(b.optString("appName"), ignoreCase = true) }
        return JSONArray(apps).toString()
    }

    /**
     * Connect to an app's media browser service, starting its process if
     * needed; replaces any existing connection. Async; reports through
     * onConnectResult with the browse-tree root id on success.
     */
    fun connect(requestId: Int, packageName: String?, serviceClass: String?) {
        mainHandler.post {
            closeBrowser()
            val myGeneration = generation
            val settled = booleanArrayOf(false)
            val browserRef = arrayOfNulls<MediaBrowser>(1)
            val newBrowser = MediaBrowser(
                appContext,
                ComponentName(packageName!!, serviceClass!!),
                object : MediaBrowser.ConnectionCallback() {
                    override fun onConnected() {
                        if (generation != myGeneration || settled[0]) {
                            return
                        }
                        settled[0] = true
                        var rootId = ""
                        try {
                            rootId = browserRef[0]!!.root
                        } catch (e: Exception) {
                            Log.w(TAG, "getRoot failed", e)
                        }
                        emitConnectResult(requestId, true, rootId, "")
                    }

                    override fun onConnectionFailed() {
                        if (generation != myGeneration || settled[0]) {
                            return
                        }
                        settled[0] = true
                        closeBrowser()
                        emitConnectResult(requestId, false, "", "Connection refused by $packageName")
                    }

                    override fun onConnectionSuspended() {
                        if (generation != myGeneration) {
                            return
                        }
                        val currentListener = listener
                        if (currentListener != null) {
                            currentListener.onDisconnected()
                        }
                    }
                },
                null
            )
            browserRef[0] = newBrowser
            browser = newBrowser
            mainHandler.postDelayed({
                if (generation != myGeneration || settled[0]) {
                    return@postDelayed
                }
                settled[0] = true
                closeBrowser()
                emitConnectResult(requestId, false, "", "Connection to $packageName timed out")
            }, CONNECT_TIMEOUT_MS)
            try {
                newBrowser.connect()
            } catch (e: Exception) {
                if (!settled[0]) {
                    settled[0] = true
                    closeBrowser()
                    emitConnectResult(requestId, false, "", "Connection failed: " + e.message)
                }
            }
        }
    }

    /**
     * Fetch one level of the connected service's content tree. Async; reports
     * through onBrowseResult with children as JSON:
     * [{"mediaId": ..., "title": ..., "subtitle": ..., "browsable": bool, "playable": bool}, ...].
     */
    fun browse(requestId: Int, parentId: String?) {
        mainHandler.post {
            val currentBrowser = browser
            if (currentBrowser == null || !currentBrowser.isConnected) {
                emitBrowseResult(requestId, "", "Not connected")
                return@post
            }
            val myGeneration = generation
            val settled = booleanArrayOf(false)
            mainHandler.postDelayed({
                if (generation != myGeneration || settled[0]) {
                    return@postDelayed
                }
                settled[0] = true
                try {
                    currentBrowser.unsubscribe(parentId!!)
                } catch (ignored: Exception) {
                }
                emitBrowseResult(requestId, "", "Browse timed out")
            }, BROWSE_TIMEOUT_MS)
            try {
                currentBrowser.subscribe(parentId!!, object : MediaBrowser.SubscriptionCallback() {
                    override fun onChildrenLoaded(loadedParentId: String, children: List<MediaBrowser.MediaItem>) {
                        if (generation != myGeneration || settled[0]) {
                            return
                        }
                        settled[0] = true
                        // One snapshot is all we want; unsubscribe outside the callback.
                        mainHandler.post {
                            try {
                                currentBrowser.unsubscribe(loadedParentId)
                            } catch (ignored: Exception) {
                            }
                        }
                        emitBrowseResult(requestId, serializeChildren(children), "")
                    }

                    override fun onError(erroredParentId: String) {
                        if (generation != myGeneration || settled[0]) {
                            return
                        }
                        settled[0] = true
                        mainHandler.post {
                            try {
                                currentBrowser.unsubscribe(erroredParentId)
                            } catch (ignored: Exception) {
                            }
                        }
                        emitBrowseResult(requestId, "", "Browse failed")
                    }
                })
            } catch (e: Exception) {
                if (!settled[0]) {
                    settled[0] = true
                    emitBrowseResult(requestId, "", "Browse failed: " + e.message)
                }
            }
        }
    }

    /** Start playback of a browsed item through the connected service's session. */
    fun playFromMediaId(mediaId: String?) {
        mainHandler.post {
            val currentBrowser = browser
            if (currentBrowser == null || !currentBrowser.isConnected) {
                return@post
            }
            try {
                val controller = MediaController(appContext, currentBrowser.sessionToken)
                controller.transportControls.playFromMediaId(mediaId, null)
                lastPlayCommandAtMs = SystemClock.elapsedRealtime()
            } catch (e: Exception) {
                Log.w(TAG, "playFromMediaId failed", e)
            }
        }
    }

    fun disconnect() {
        mainHandler.post {
            val sincePlayMs = SystemClock.elapsedRealtime() - lastPlayCommandAtMs
            val graceMs = if (lastPlayCommandAtMs == 0L) 0 else PLAY_DISCONNECT_GRACE_MS - sincePlayMs
            if (graceMs <= 0) {
                closeBrowser()
                return@post
            }
            val lingering = browser
            browser = null
            generation++
            if (lingering != null) {
                mainHandler.postDelayed({
                    try {
                        lingering.disconnect()
                    } catch (ignored: Exception) {
                    }
                }, graceMs)
            }
        }
    }

    private fun closeBrowser() {
        generation++
        val currentBrowser = browser
        if (currentBrowser != null) {
            try {
                currentBrowser.disconnect()
            } catch (ignored: Exception) {
            }
            browser = null
        }
    }

    private fun serializeChildren(children: List<MediaBrowser.MediaItem>?): String {
        val out = JSONArray()
        if (children == null) {
            return out.toString()
        }
        for (item in children) {
            try {
                val title: CharSequence? = if (item.description == null) null else item.description.title
                val subtitle: CharSequence? = if (item.description == null) null else item.description.subtitle
                val entry = JSONObject()
                entry.put("mediaId", if (item.mediaId == null) "" else item.mediaId)
                entry.put("title", if (title == null) "" else title.toString())
                entry.put("subtitle", if (subtitle == null) "" else subtitle.toString())
                entry.put("browsable", item.isBrowsable)
                entry.put("playable", item.isPlayable)
                out.put(entry)
            } catch (e: Exception) {
                Log.w(TAG, "media item serialization failed", e)
            }
        }
        return out.toString()
    }

    private fun emitConnectResult(requestId: Int, connected: Boolean, rootId: String?, error: String?) {
        val currentListener = listener
        if (currentListener != null) {
            currentListener.onConnectResult(requestId, connected, rootId, error)
        }
    }

    private fun emitBrowseResult(requestId: Int, childrenJson: String?, error: String?) {
        val currentListener = listener
        if (currentListener != null) {
            currentListener.onBrowseResult(requestId, childrenJson, error)
        }
    }
}
