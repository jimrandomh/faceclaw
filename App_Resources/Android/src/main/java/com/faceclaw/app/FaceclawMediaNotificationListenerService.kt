package com.faceclaw.app

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

import java.io.ByteArrayOutputStream
import java.util.Arrays
import java.util.Comparator
import java.util.HashSet
import java.util.concurrent.CopyOnWriteArraySet

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

class FaceclawMediaNotificationListenerService : NotificationListenerService() {
    companion object {
        private const val TAG = "FaceclawNotify"
        private const val EXTRA_SUBSTITUTE_APP_NAME = "android.substName"
        /**
         * How long notification access can be granted with no listener
         * connected before the watchdog forces a rebind: longer than a
         * normal bind at process start, and than the system's own single
         * retry 10 s after a binding dies. Later attempts double from here.
         */
        private const val REBIND_GRACE_MS = 15_000L
        private const val REBIND_MAX_DELAY_MS = 15 * 60_000L
        /** Missing this long, the listener needs the user to toggle notification access. */
        private const val LISTENER_STUCK_MS = 30_000L
        /** Notifications posted while disconnected alert on reconnect only if this recent. */
        private const val RECONNECT_ALERT_WINDOW_MS = 5 * 60_000L

        /** The connected listener; null until onListenerConnected and after onListenerDisconnected. */
        @Volatile
        private var activeService: FaceclawMediaNotificationListenerService? = null
        private val mainHandler = Handler(Looper.getMainLooper())
        private val notificationListeners: MutableSet<FaceclawNotificationListener> = CopyOnWriteArraySet()
        private val listenerStateObservers: MutableSet<Runnable> = CopyOnWriteArraySet()
        private val activeNotificationWakeKeys: MutableSet<String> = HashSet()

        // Binding watchdog (see watchListenerBinding); written on the main thread only.
        private var watchdogContext: Context? = null
        private var rebindScheduled = false
        private var rebindDelayMs = REBIND_GRACE_MS
        /** elapsedRealtime when the watchdog first saw access granted with no listener; 0 when not missing. */
        @Volatile
        private var listenerMissingSinceMs = 0L
        /** Wall-clock time of the last disconnect in this process (compared with postTime); 0 if none. */
        private var lastListenerDisconnectAtMs = 0L
        private val forceRebindTask = Runnable { forceRebindIfStillMissing() }
        private val accessObserver = object : ContentObserver(mainHandler) {
            override fun onChange(selfChange: Boolean) {
                checkListenerBinding()
                notifyListenerStateChanged()
            }
        }

        /**
         * Start watching for the listener going missing while notification
         * access is granted. Android can drop a listener's binding, or give
         * up rebinding it after the process dies, and not bring it back;
         * every read then comes back empty for the life of the process.
         * Called at app boot; disconnects and access changes re-check.
         */
        @JvmStatic
        fun watchListenerBinding(context: Context?) {
            if (context == null) {
                return
            }
            val appContext = context.applicationContext
            mainHandler.post {
                if (watchdogContext == null) {
                    watchdogContext = appContext
                    try {
                        appContext.contentResolver.registerContentObserver(
                            Settings.Secure.getUriFor("enabled_notification_listeners"), false, accessObserver)
                    } catch (t: Throwable) {
                        Log.w(TAG, "notification access observer registration failed", t)
                    }
                }
                checkListenerBinding()
            }
        }

        /**
         * "connected"; "no-access" (notification access not granted);
         * "connecting" (granted, listener not connected yet); or "stuck"
         * (granted, but still missing past LISTENER_STUCK_MS, which forced
         * rebinds can't always fix: the user has to toggle access).
         */
        @JvmStatic
        fun getListenerState(context: Context?): String {
            if (activeService != null) {
                return "connected"
            }
            if (!FaceclawEvenAppDetector.isNotificationAccessEnabled(context)) {
                return "no-access"
            }
            val missingSince = listenerMissingSinceMs
            if (missingSince > 0 && SystemClock.elapsedRealtime() - missingSince >= LISTENER_STUCK_MS) {
                return "stuck"
            }
            return "connecting"
        }

        /** Run on the main thread whenever getListenerState may have changed. */
        @JvmStatic
        fun addListenerStateObserver(observer: Runnable?) {
            if (observer != null) {
                listenerStateObservers.add(observer)
            }
        }

        @JvmStatic
        fun removeListenerStateObserver(observer: Runnable?) {
            if (observer != null) {
                listenerStateObservers.remove(observer)
            }
        }

        private fun notifyListenerStateChanged() {
            for (observer in listenerStateObservers) {
                mainHandler.post {
                    try {
                        observer.run()
                    } catch (t: Throwable) {
                        Log.w(TAG, "listener state observer failed", t)
                    }
                }
            }
        }

        /** Main thread. Starts the forced-rebind countdown when access is granted and no listener is connected. */
        private fun checkListenerBinding() {
            val context = watchdogContext ?: return
            if (activeService != null || !FaceclawEvenAppDetector.isNotificationAccessEnabled(context)) {
                resetRebindWatchdog()
                return
            }
            if (listenerMissingSinceMs == 0L) {
                listenerMissingSinceMs = SystemClock.elapsedRealtime()
            }
            scheduleForcedRebind()
        }

        private fun scheduleForcedRebind() {
            if (!rebindScheduled) {
                rebindScheduled = true
                mainHandler.postDelayed(forceRebindTask, rebindDelayMs)
            }
        }

        private fun resetRebindWatchdog() {
            mainHandler.removeCallbacks(forceRebindTask)
            rebindScheduled = false
            rebindDelayMs = REBIND_GRACE_MS
            listenerMissingSinceMs = 0L
        }

        private fun forceRebindIfStillMissing() {
            rebindScheduled = false
            val context = watchdogContext ?: return
            if (activeService != null || !FaceclawEvenAppDetector.isNotificationAccessEnabled(context)) {
                resetRebindWatchdog()
                return
            }
            val missingSeconds = (SystemClock.elapsedRealtime() - listenerMissingSinceMs) / 1000
            Log.w(TAG, "notification access granted but no listener connected for ${missingSeconds}s; forcing a rebind")
            val component = ComponentName(context, FaceclawMediaNotificationListenerService::class.java)
            try {
                // requestRebind only undoes a requestUnbind, so alone it can't
                // bring back a binding the system dropped. Unbinding by
                // component first marks the listener snoozed and drops any
                // record of it; the rebind then un-snoozes it and binds afresh.
                // Below API 34 there is no public equivalent (and flipping the
                // component's enabled state can make the system revoke
                // access), so there the state goes "stuck" for the user.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    NotificationListenerService.requestUnbind(component)
                }
                NotificationListenerService.requestRebind(component)
            } catch (t: Throwable) {
                Log.w(TAG, "forced notification listener rebind failed", t)
            }
            rebindDelayMs = Math.min(rebindDelayMs * 2, REBIND_MAX_DELAY_MS)
            scheduleForcedRebind()
            notifyListenerStateChanged()
        }

        @JvmStatic
        fun addNotificationListener(listener: FaceclawNotificationListener?) {
            if (listener != null) {
                notificationListeners.add(listener)
            }
        }

        @JvmStatic
        fun removeNotificationListener(listener: FaceclawNotificationListener?) {
            if (listener != null) {
                notificationListeners.remove(listener)
            }
        }

        @JvmStatic
        fun hasActiveNotificationTitle(expectedTitle: String?): Boolean {
            val service = activeService
            if (service == null || expectedTitle == null || expectedTitle.isEmpty()) {
                return false
            }
            val notifications: Array<StatusBarNotification?>?
            try {
                notifications = service.activeNotifications
            } catch (e: SecurityException) {
                Log.w(TAG, "notification access denied while checking active notifications", e)
                return false
            } catch (t: Throwable) {
                Log.w(TAG, "failed to check active notifications", t)
                return false
            }
            if (notifications == null || notifications.size == 0) {
                return false
            }
            for (notification in notifications) {
                if (notification == null || notification.notification == null) {
                    continue
                }
                val extras: Bundle? = notification.notification.extras
                if (extras == null) {
                    continue
                }
                val title: CharSequence? = extras.getCharSequence(Notification.EXTRA_TITLE)
                if (title != null && expectedTitle.contentEquals(title)) {
                    return true
                }
            }
            return false
        }

        /**
         * The tray's notification icons, iconSize*iconSize gray bytes each: one
         * per notification group. When keysOut is given, each icon's
         * notification key (the group member it was taken from) is appended
         * to it in step, so the tray can tell which notification an icon is.
         */
        @JvmStatic
        fun getActiveNotificationIconGrays(iconSize: Int, maxIcons: Int, keysOut: MutableList<String>?): ByteArray {
            val service = activeService
            val size = Math.max(1, Math.min(96, iconSize))
            val limit = Math.max(0, maxIcons)
            if (service == null || limit == 0) {
                return ByteArray(0)
            }

            val notifications: Array<StatusBarNotification?>?
            try {
                notifications = service.activeNotifications
            } catch (e: SecurityException) {
                Log.w(TAG, "notification access denied while reading icons", e)
                return ByteArray(0)
            } catch (t: Throwable) {
                Log.w(TAG, "failed to read notification icons", t)
                return ByteArray(0)
            }
            if (notifications == null || notifications.size == 0) {
                return ByteArray(0)
            }

            val out = ByteArrayOutputStream(size * size * Math.min(limit, notifications.size))
            val emittedGroupKeys: MutableSet<String> = HashSet()
            var emitted = 0
            for (statusBarNotification in notifications) {
                if (!shouldShowNotificationIcon(service, statusBarNotification)) {
                    continue
                }
                val dedupeGroupKey = getNotificationDedupeGroupKey(statusBarNotification!!)
                if (dedupeGroupKey != null && emittedGroupKeys.contains(dedupeGroupKey)) {
                    continue
                }
                val icon = NotificationIconLoader.iconFor(service, statusBarNotification, size) {
                    getNotificationAppName(service, statusBarNotification)
                }
                if (icon == null) {
                    Log.i(TAG, "icon skipped (nothing to draw): " + statusBarNotification.packageName)
                    continue
                }
                Log.i(TAG, "icon[" + emitted + "] pkg=" + statusBarNotification.packageName
                    + " source=" + icon.source + " kind=" + icon.art.kind)
                out.write(icon.art.gray)
                keysOut?.add(statusBarNotification.key ?: "")
                if (dedupeGroupKey != null) {
                    emittedGroupKeys.add(dedupeGroupKey)
                }
                emitted += 1
                if (emitted >= limit) {
                    break
                }
            }
            return out.toByteArray()
        }

        /**
         * Grayscale icon (iconSize*iconSize bytes) for one active notification,
         * identified by its key; empty array when the notification or its icon is
         * unavailable. Shares the extraction/scaling pipeline with the tray icon
         * strip above.
         */
        @JvmStatic
        fun getNotificationIconGrayForKey(key: String?, iconSize: Int): ByteArray {
            val service = activeService
            val size = Math.max(1, Math.min(96, iconSize))
            if (service == null) {
                return ByteArray(0)
            }
            val statusBarNotification = findActiveNotificationByKey(service, key)
            if (statusBarNotification == null || statusBarNotification.notification == null) {
                return ByteArray(0)
            }
            val icon = NotificationIconLoader.iconFor(service, statusBarNotification, size) {
                getNotificationAppName(service, statusBarNotification)
            }
            return icon?.art?.gray ?: ByteArray(0)
        }

        /**
         * The picture attached to one active notification (BigPictureStyle: a
         * photo, a screenshot, Dexcom's glucose graph), scaled to fit
         * maxWidth x maxHeight as a gray packet with the tone handling (and
         * light-background inversion) of ImageFileLoader.bitmapToGrayPacket;
         * empty when the notification or its picture is unavailable.
         */
        @JvmStatic
        fun getNotificationPictureGray(
            key: String?, maxWidth: Int, maxHeight: Int, gamma: Float, dither: Boolean, invertLightBackground: Boolean,
        ): ByteArray {
            val service = activeService
            if (service == null || maxWidth <= 0 || maxHeight <= 0) {
                return ByteArray(0)
            }
            val statusBarNotification = findActiveNotificationByKey(service, key)
            if (statusBarNotification == null || statusBarNotification.notification == null) {
                return ByteArray(0)
            }
            val picture = loadNotificationPicture(service, statusBarNotification.notification)
            if (picture == null) {
                return ByteArray(0)
            }
            return ImageFileLoader.bitmapToGrayPacket(
                halveToward(picture, maxWidth, maxHeight), maxWidth, maxHeight, gamma, dither, invertLightBackground)
        }

        @JvmStatic
        fun getActiveNotificationsJson(maxNotifications: Int): String {
            val service = activeService
            val limit = Math.max(0, maxNotifications)
            if (service == null || limit == 0) {
                return "[]"
            }

            val notifications: Array<StatusBarNotification?>?
            try {
                notifications = service.activeNotifications
            } catch (e: SecurityException) {
                Log.w(TAG, "notification access denied while reading notifications", e)
                return "[]"
            } catch (t: Throwable) {
                Log.w(TAG, "failed to read notifications", t)
                return "[]"
            }
            if (notifications == null || notifications.size == 0) {
                return "[]"
            }

            Arrays.sort(notifications, object : Comparator<StatusBarNotification?> {
                override fun compare(a: StatusBarNotification?, b: StatusBarNotification?): Int {
                    val left = if (a == null) 0L else a.postTime
                    val right = if (b == null) 0L else b.postTime
                    return java.lang.Long.compare(right, left)
                }
            })

            val out = JSONArray()
            for (statusBarNotification in notifications) {
                if (out.length() >= limit) {
                    break
                }
                if (!shouldShowNotificationInList(service, statusBarNotification)) {
                    continue
                }
                try {
                    out.put(buildNotificationJson(service, statusBarNotification!!))
                } catch (t: Throwable) {
                    Log.w(TAG, "failed to serialize notification", t)
                }
            }
            return out.toString()
        }

        @JvmStatic
        fun invokeNotificationAction(key: String?, actionIndex: Int): Boolean {
            val service = activeService
            val statusBarNotification = findActiveNotificationByKey(service, key)
            if (statusBarNotification == null || statusBarNotification.notification == null) {
                return false
            }
            val actions: Array<Notification.Action>? = statusBarNotification.notification.actions
            if (actions == null || actionIndex < 0 || actionIndex >= actions.size) {
                return false
            }
            val intent: PendingIntent? = actions[actionIndex].actionIntent
            if (intent == null) {
                return false
            }
            try {
                intent.send()
                return true
            } catch (e: PendingIntent.CanceledException) {
                Log.w(TAG, "notification action pending intent was canceled", e)
                return false
            } catch (t: Throwable) {
                Log.w(TAG, "failed to invoke notification action", t)
                return false
            }
        }

        @JvmStatic
        fun dismissNotification(key: String?): Boolean {
            val service = activeService
            if (service == null || key == null || key.isEmpty()) {
                return false
            }
            try {
                service.cancelNotification(key)
                return true
            } catch (e: SecurityException) {
                Log.w(TAG, "notification access denied while dismissing notification", e)
                return false
            } catch (t: Throwable) {
                Log.w(TAG, "failed to dismiss notification", t)
                return false
            }
        }

        private fun emitNotificationPosted(key: String?) {
            emitNotificationEvent(key) { listener, eventKey -> listener.onNotificationPosted(eventKey) }
        }

        private fun emitNotificationRemoved(key: String?) {
            emitNotificationEvent(key) { listener, eventKey -> listener.onNotificationRemoved(eventKey) }
        }

        private fun emitNotificationEvent(key: String?, deliver: (FaceclawNotificationListener, String) -> Unit) {
            if (key == null || key.isEmpty() || notificationListeners.isEmpty()) {
                return
            }
            for (listener in notificationListeners) {
                mainHandler.post {
                    try {
                        deliver(listener, key)
                    } catch (t: Throwable) {
                        Log.w(TAG, "notification listener failed", t)
                    }
                }
            }
        }

        /**
         * Re-seed the wake keys from what is active now. After a reconnect
         * this also catches the glasses up on the gap: keys that went away
         * are reported removed (closing a popup for a notification
         * dismissed meanwhile), and recent notifications posted since the
         * disconnect are reported posted. A first connect only seeds.
         */
        private fun reconcileActiveNotificationWakeKeys(service: FaceclawMediaNotificationListenerService) {
            val notifications: Array<StatusBarNotification?>?
            try {
                notifications = service.activeNotifications
            } catch (t: Throwable) {
                Log.w(TAG, "failed to refresh active notification wake keys", t)
                return
            }
            if (notifications == null) {
                return
            }
            val disconnectedAtMs = lastListenerDisconnectAtMs
            val alertAfterMs = Math.max(disconnectedAtMs, System.currentTimeMillis() - RECONNECT_ALERT_WINDOW_MS)
            val posted = ArrayList<String>()
            val removed = ArrayList<String>()
            synchronized(activeNotificationWakeKeys) {
                val previous = HashSet(activeNotificationWakeKeys)
                activeNotificationWakeKeys.clear()
                for (statusBarNotification in notifications) {
                    if (!shouldShowNotificationInList(service, statusBarNotification)) {
                        continue
                    }
                    val key: String? = statusBarNotification!!.key
                    if (key == null || key.isEmpty()) {
                        continue
                    }
                    activeNotificationWakeKeys.add(key)
                    if (disconnectedAtMs > 0 && !previous.contains(key) && statusBarNotification.postTime > alertAfterMs) {
                        posted.add(key)
                    }
                }
                for (key in previous) {
                    if (!activeNotificationWakeKeys.contains(key)) {
                        removed.add(key)
                    }
                }
            }
            for (key in removed) {
                emitNotificationRemoved(key)
            }
            for (key in posted) {
                emitNotificationPosted(key)
            }
        }

        private fun shouldEmitNotificationPosted(statusBarNotification: StatusBarNotification): Boolean {
            val key: String? = statusBarNotification.key
            if (key == null || key.isEmpty()) {
                return true
            }

            val alreadyActive: Boolean
            synchronized(activeNotificationWakeKeys) {
                alreadyActive = activeNotificationWakeKeys.contains(key)
                activeNotificationWakeKeys.add(key)
            }
            return !alreadyActive || !isPersistentNotification(statusBarNotification)
        }

        /** Stop tracking a notification; returns whether it was tracked (i.e. listed on the glasses). */
        private fun forgetActiveNotificationWakeKey(statusBarNotification: StatusBarNotification?): Boolean {
            if (statusBarNotification == null) {
                return false
            }
            val key: String? = statusBarNotification.key
            if (key == null || key.isEmpty()) {
                return false
            }
            synchronized(activeNotificationWakeKeys) {
                return activeNotificationWakeKeys.remove(key)
            }
        }

        private fun isPersistentNotification(statusBarNotification: StatusBarNotification): Boolean {
            val notification: Notification? = statusBarNotification.notification
            if (notification == null) {
                return false
            }
            val persistentFlags = Notification.FLAG_ONGOING_EVENT or Notification.FLAG_NO_CLEAR
            return (notification.flags and persistentFlags) != 0
        }

        private fun shouldShowNotificationIcon(service: FaceclawMediaNotificationListenerService, statusBarNotification: StatusBarNotification?): Boolean {
            if (!shouldShowNotificationInList(service, statusBarNotification)) {
                return false
            }
            val notification = statusBarNotification!!.notification
            if ((notification.flags and Notification.FLAG_GROUP_SUMMARY) != 0) {
                return false
            }
            return true
        }

        private fun shouldShowNotificationInList(service: FaceclawMediaNotificationListenerService, statusBarNotification: StatusBarNotification?): Boolean {
            if (statusBarNotification == null || statusBarNotification.notification == null) {
                return false
            }
            // Our own notifications stay out of the mirror: the foreground-service
            // one is noise, and the Timers app rings on the glasses itself (its
            // phone notification is for the phone), so mirroring it would stack a
            // notification modal over the ringing screen.
            if (service.packageName == statusBarNotification.packageName) {
                return false
            }
            val notification = statusBarNotification.notification
            if (Notification.CATEGORY_TRANSPORT == notification.category) {
                return false
            }
            val extras: Bundle? = notification.extras
            if (extras != null && extras.containsKey("android.mediaSession")) {
                return false
            }

            val rankingMap: NotificationListenerService.RankingMap? = service.currentRanking
            if (rankingMap == null) {
                return true
            }
            val ranking = NotificationListenerService.Ranking()
            if (!rankingMap.getRanking(statusBarNotification.key, ranking)) {
                return true
            }
            val importance = ranking.importance
            return importance > NotificationManager.IMPORTANCE_MIN
        }

        private fun getNotificationDedupeGroupKey(statusBarNotification: StatusBarNotification): String? {
            val notification = statusBarNotification.notification
            if (notification.group == null && statusBarNotification.overrideGroupKey == null) {
                return null
            }
            val groupKey: String? = statusBarNotification.groupKey
            if (groupKey == null || groupKey.isEmpty()) {
                return null
            }
            // Group children often share the same small icon. Emit only one icon for the group.
            return groupKey
        }

        /** Whether a notification carries a picture for loadNotificationPicture, without loading it. */
        @Suppress("DEPRECATION")
        private fun hasNotificationPicture(extras: Bundle): Boolean {
            return extras.get(Notification.EXTRA_PICTURE) != null
                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && extras.get(Notification.EXTRA_PICTURE_ICON) != null)
        }

        /**
         * A notification's attached picture: BigPictureStyle's bitmap
         * (EXTRA_PICTURE) or, from Android 12, its Icon (EXTRA_PICTURE_ICON).
         * Newer releases swap large pictures for a content URI to a bitmap
         * the system has offloaded (Dexcom's graph arrives that way); the
         * offload provider lets enabled notification listeners open those.
         */
        @Suppress("DEPRECATION")
        private fun loadNotificationPicture(service: FaceclawMediaNotificationListenerService, notification: Notification): Bitmap? {
            val extras: Bundle = notification.extras ?: return null
            try {
                val picture: Bitmap? = extras.getParcelable(Notification.EXTRA_PICTURE)
                if (picture != null) {
                    return softwareBitmap(picture)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "failed to read notification picture", t)
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                return null
            }
            try {
                val icon: Icon? = extras.getParcelable(Notification.EXTRA_PICTURE_ICON)
                val drawable: Drawable? = icon?.loadDrawable(service)
                if (drawable is BitmapDrawable && drawable.bitmap != null) {
                    return softwareBitmap(drawable.bitmap)
                }
                if (drawable != null && drawable.intrinsicWidth > 0 && drawable.intrinsicHeight > 0) {
                    val bitmap = Bitmap.createBitmap(drawable.intrinsicWidth, drawable.intrinsicHeight, Bitmap.Config.ARGB_8888)
                    drawable.setBounds(0, 0, bitmap.width, bitmap.height)
                    drawable.draw(Canvas(bitmap))
                    return bitmap
                }
            } catch (t: Throwable) {
                Log.w(TAG, "failed to load notification picture icon", t)
            }
            return null
        }

        /** Hardware bitmaps can't be read back pixel by pixel or drawn on a software canvas; copy those. */
        private fun softwareBitmap(bitmap: Bitmap): Bitmap {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && bitmap.config == Bitmap.Config.HARDWARE) {
                return bitmap.copy(Bitmap.Config.ARGB_8888, false)
            }
            return bitmap
        }

        /**
         * Halve a picture while it is still at least twice the size it will
         * be shown at, leaving the last (under 2x) step of fitting it into
         * maxWidth x maxHeight to bitmapToGrayPacket. As with icons
         * (NotificationIconLoader.renderArgb), one filtered pass from a much larger source
         * samples too sparsely: a graph's thin lines break up into dots.
         */
        private fun halveToward(source: Bitmap, maxWidth: Int, maxHeight: Int): Bitmap {
            var bitmap = source
            while ((bitmap.width >= maxWidth * 2 || bitmap.height >= maxHeight * 2) && bitmap.width >= 2 && bitmap.height >= 2) {
                val halved = Bitmap.createScaledBitmap(bitmap, bitmap.width / 2, bitmap.height / 2, true)
                if (bitmap !== source) {
                    bitmap.recycle()
                }
                bitmap = halved
            }
            return bitmap
        }

        private fun findActiveNotificationByKey(service: FaceclawMediaNotificationListenerService?, key: String?): StatusBarNotification? {
            if (service == null || key == null || key.isEmpty()) {
                return null
            }
            val notifications: Array<StatusBarNotification?>?
            try {
                notifications = service.activeNotifications
            } catch (t: Throwable) {
                Log.w(TAG, "failed to find active notification", t)
                return null
            }
            if (notifications == null) {
                return null
            }
            for (statusBarNotification in notifications) {
                if (statusBarNotification != null && key == statusBarNotification.key) {
                    return statusBarNotification
                }
            }
            return null
        }

        @Throws(JSONException::class)
        private fun buildNotificationJson(service: FaceclawMediaNotificationListenerService, statusBarNotification: StatusBarNotification): JSONObject {
            val notification = statusBarNotification.notification
            val extras: Bundle? = notification.extras
            val out = JSONObject()
            out.put("key", statusBarNotification.key)
            out.put("packageName", statusBarNotification.packageName)
            out.put("appName", getNotificationAppName(service, statusBarNotification))
            out.put("postTime", statusBarNotification.postTime)
            out.put("when", notification.`when`)
            out.put("foregroundService", (notification.flags and Notification.FLAG_FOREGROUND_SERVICE) != 0)
            putString(out, "category", notification.category)
            if (extras != null) {
                putCharSequence(out, "title", firstNonEmpty(
                    extras.getCharSequence(Notification.EXTRA_TITLE_BIG),
                    extras.getCharSequence(Notification.EXTRA_TITLE)
                ))
                putCharSequence(out, "text", extras.getCharSequence(Notification.EXTRA_TEXT))
                putCharSequence(out, "bigText", extras.getCharSequence(Notification.EXTRA_BIG_TEXT))
                putCharSequence(out, "subText", extras.getCharSequence(Notification.EXTRA_SUB_TEXT))
                putCharSequence(out, "infoText", extras.getCharSequence(Notification.EXTRA_INFO_TEXT))
                putCharSequence(out, "summaryText", extras.getCharSequence(Notification.EXTRA_SUMMARY_TEXT))
                val textLines: Array<CharSequence>? = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
                val lines = JSONArray()
                if (textLines != null) {
                    for (line in textLines) {
                        val text = charSequenceToString(line)
                        if (!text.isEmpty()) {
                            lines.put(text)
                        }
                    }
                }
                out.put("lines", lines)
                out.put("hasPicture", hasNotificationPicture(extras))
            } else {
                out.put("lines", JSONArray())
                out.put("hasPicture", false)
            }

            val actionsJson = JSONArray()
            val actions: Array<Notification.Action?>? = notification.actions
            if (actions != null) {
                for (index in actions.indices) {
                    val action = actions[index]
                    if (action == null) {
                        continue
                    }
                    val title = charSequenceToString(action.title)
                    if (title.isEmpty()) {
                        continue
                    }
                    val actionJson = JSONObject()
                    actionJson.put("index", index)
                    actionJson.put("title", title)
                    actionJson.put("enabled", action.actionIntent != null)
                    actionsJson.put(actionJson)
                }
            }
            out.put("actions", actionsJson)
            return out
        }

        private fun getNotificationAppName(service: FaceclawMediaNotificationListenerService, statusBarNotification: StatusBarNotification): String {
            val notification = statusBarNotification.notification
            val extras: Bundle? = notification.extras
            if (extras != null) {
                val substituteName = charSequenceToString(extras.getCharSequence(EXTRA_SUBSTITUTE_APP_NAME))
                if (!substituteName.isEmpty()) {
                    return substituteName
                }
            }
            return getAppLabel(service, statusBarNotification.packageName)
        }

        private fun getAppLabel(service: FaceclawMediaNotificationListenerService, packageName: String?): String {
            if (packageName == null || packageName.isEmpty()) {
                return ""
            }
            try {
                val label: CharSequence? = service
                    .packageManager
                    .getApplicationLabel(service.packageManager.getApplicationInfo(packageName, 0))
                val text = charSequenceToString(label)
                return if (text.isEmpty()) packageName else text
            } catch (t: Throwable) {
                return packageName
            }
        }

        @Throws(JSONException::class)
        private fun putString(out: JSONObject, key: String, value: String?) {
            out.put(key, value ?: "")
        }

        @Throws(JSONException::class)
        private fun putCharSequence(out: JSONObject, key: String, value: CharSequence?) {
            out.put(key, charSequenceToString(value))
        }

        private fun firstNonEmpty(first: CharSequence?, second: CharSequence?): CharSequence? {
            return if (charSequenceToString(first).isEmpty()) second else first
        }

        private fun charSequenceToString(value: CharSequence?): String {
            return value?.toString() ?: ""
        }
    }

    override fun onListenerConnected() {
        activeService = this
        super.onListenerConnected()
        Log.i(TAG, "notification listener connected")
        resetRebindWatchdog()
        reconcileActiveNotificationWakeKeys(this)
        notifyListenerStateChanged()
    }

    // Also called from onDestroy, which is how an unbind usually arrives.
    override fun onListenerDisconnected() {
        if (activeService === this) {
            activeService = null
            lastListenerDisconnectAtMs = System.currentTimeMillis()
            Log.w(TAG, "notification listener disconnected")
            notifyListenerStateChanged()
        }
        super.onListenerDisconnected()
        watchListenerBinding(applicationContext)
    }

    override fun onNotificationPosted(statusBarNotification: StatusBarNotification?) {
        super.onNotificationPosted(statusBarNotification)
        if (!shouldShowNotificationInList(this, statusBarNotification)) {
            // An update that takes a listed notification off the list removes it as far as the glasses go.
            if (forgetActiveNotificationWakeKey(statusBarNotification)) {
                emitNotificationRemoved(statusBarNotification!!.key)
            }
            return
        }
        if (shouldEmitNotificationPosted(statusBarNotification!!)) {
            emitNotificationPosted(statusBarNotification.key)
        }
    }

    override fun onNotificationRemoved(statusBarNotification: StatusBarNotification?) {
        // Includes notifications their source cancels on its own, e.g. a
        // short-lived foreground-service notification that was standing in
        // for one posted moments later under another key.
        if (forgetActiveNotificationWakeKey(statusBarNotification)) {
            emitNotificationRemoved(statusBarNotification!!.key)
        }
        super.onNotificationRemoved(statusBarNotification)
    }
}
