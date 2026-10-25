package com.faceclaw.app

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
        private const val NOTIFICATION_ICON_GAMMA = 1.6
        /** Alpha at or below this is treated as cut out when classifying an icon. */
        private const val TEMPLATE_ALPHA_FLOOR = 32
        /** Spread between an icon pixel's brightest and darkest channel that reads as hue. */
        private const val TEMPLATE_CHROMA_THRESHOLD = 24
        private const val EXTRA_SUBSTITUTE_APP_NAME = "android.substName"

        /** Set once the debug-icon directory has been cleaned for this process. */
        @Volatile
        private var debugIconsPruned = false

        @Volatile
        private var activeService: FaceclawMediaNotificationListenerService? = null
        private val mainHandler = Handler(Looper.getMainLooper())
        private val notificationListeners: MutableSet<FaceclawNotificationListener> = CopyOnWriteArraySet()
        private val activeNotificationWakeKeys: MutableSet<String> = HashSet()

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
                val drawable = loadNotificationIcon(service, statusBarNotification.notification)
                if (drawable == null) {
                    Log.i(TAG, "icon skipped (no drawable): " + statusBarNotification.packageName)
                    continue
                }
                Log.i(TAG, "icon[" + emitted + "] pkg=" + statusBarNotification.packageName
                    + " drawable=" + drawable.javaClass.simpleName
                    + " intrinsic=" + drawable.intrinsicWidth + "x" + drawable.intrinsicHeight)
                appendIconGrayBytes(drawable, size, out, service, emitted, statusBarNotification.packageName)
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
            val drawable = loadNotificationIcon(service, statusBarNotification.notification)
            if (drawable == null) {
                return ByteArray(0)
            }
            val out = ByteArrayOutputStream(size * size)
            appendIconGrayBytes(drawable, size, out, service, -1, statusBarNotification.packageName)
            return out.toByteArray()
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

        private fun refreshActiveNotificationWakeKeys(service: FaceclawMediaNotificationListenerService) {
            val notifications: Array<StatusBarNotification?>?
            try {
                notifications = service.activeNotifications
            } catch (t: Throwable) {
                Log.w(TAG, "failed to refresh active notification wake keys", t)
                return
            }
            synchronized(activeNotificationWakeKeys) {
                activeNotificationWakeKeys.clear()
                if (notifications == null) {
                    return
                }
                for (statusBarNotification in notifications) {
                    if (shouldShowNotificationInList(service, statusBarNotification)) {
                        val key: String? = statusBarNotification!!.key
                        if (key != null && !key.isEmpty()) {
                            activeNotificationWakeKeys.add(key)
                        }
                    }
                }
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

        private fun loadNotificationIcon(service: FaceclawMediaNotificationListenerService, notification: Notification): Drawable? {
            try {
                val smallIcon: Icon? = notification.smallIcon
                if (smallIcon != null) {
                    val drawable: Drawable? = smallIcon.loadDrawable(service)
                    if (drawable != null) {
                        // Template or not is decided from the rendered pixels
                        // (see iconIsAlphaTemplate): apps also ship filled color
                        // bitmaps as their small icon, and tinting one of those
                        // white keeps the alpha while discarding the shape that
                        // the colors carried, leaving a solid block.
                        drawable.mutate()
                        if (drawable is BitmapDrawable) {
                            drawable.setFilterBitmap(true)
                        }
                        return drawable
                    }
                }
            } catch (t: Throwable) {
                Log.w(TAG, "failed to load small notification icon", t)
            }
            try {
                // Large icons are real color images (avatars, album art); keep color.
                val largeIcon: Icon? = notification.getLargeIcon()
                if (largeIcon != null) {
                    return largeIcon.loadDrawable(service)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "failed to load large notification icon", t)
            }
            return null
        }

        private fun appendIconGrayBytes(drawable: Drawable, size: Int, out: ByteArrayOutputStream,
                                        service: FaceclawMediaNotificationListenerService, index: Int, packageName: String?) {
            val bitmap = renderIconScaled(drawable, size)
            val template = iconIsAlphaTemplate(bitmap)
            dumpIconDebugPng(service, index, packageName, bitmap)
            for (y in 0 until size) {
                for (x in 0 until size) {
                    val color = bitmap.getPixel(x, y)
                    val alpha = Color.alpha(color)
                    val grayLinear = if (template) {
                        alpha / 255.0
                    } else {
                        (0.2126 * Color.red(color) + 0.7152 * Color.green(color) + 0.0722 * Color.blue(color)) * alpha / (255.0 * 255.0)
                    }
                    val gray = Math.round(255.0 * Math.pow(Math.max(0.0, Math.min(1.0, grayLinear)), NOTIFICATION_ICON_GAMMA)).toInt()
                    out.write(gray and 0xff)
                }
            }
            bitmap.recycle()
        }

        /**
         * Whether a rendered icon is an alpha template: a shape the platform
         * draws by tinting, where alpha alone carries the outline.
         *
         * Small icons are meant to be templates, but plenty of apps put a filled
         * color bitmap there instead. Tinting one of those white keeps its alpha
         * and throws away the only thing that carried the shape, so the glasses
         * got a blank block where the icon should be.
         *
         * Hue settles it: an icon with color is color artwork. A colorless icon is
         * a template only when its alpha is actually cut out, and a colorless
         * icon with solid alpha is a flat image its own brightness has to carry.
         */
        private fun iconIsAlphaTemplate(bitmap: Bitmap): Boolean {
            var opaque = 0
            var transparent = 0
            var colored = 0
            for (y in 0 until bitmap.height) {
                for (x in 0 until bitmap.width) {
                    val color = bitmap.getPixel(x, y)
                    val alpha = Color.alpha(color)
                    if (alpha < TEMPLATE_ALPHA_FLOOR) {
                        transparent += 1
                        continue
                    }
                    opaque += 1
                    val red = Color.red(color)
                    val green = Color.green(color)
                    val blue = Color.blue(color)
                    val high = Math.max(red, Math.max(green, blue))
                    val low = Math.min(red, Math.min(green, blue))
                    if (high - low >= TEMPLATE_CHROMA_THRESHOLD) colored += 1
                }
            }
            if (opaque == 0) return false
            // A quarter of the icon carrying hue is color artwork, whatever its alpha does.
            if (colored * 4 >= opaque) return false
            // Otherwise it is a template only if there is something cut out of it.
            return transparent * 20 >= opaque + transparent
        }

        /**
         * Render a drawable at the target size with proper downscaling. Detailed
         * sources (e.g. avatar bitmaps used as notification icons) are rendered at
         * native resolution and reduced by repeated halving: a single filtered pass
         * from, say, 126px to 24px samples too sparsely and turns fine detail into
         * speckle that reads as a garbled icon.
         */
        private fun renderIconScaled(drawable: Drawable, size: Int): Bitmap {
            val renderW = Math.max(size, drawable.intrinsicWidth)
            val renderH = Math.max(size, drawable.intrinsicHeight)
            var bitmap = Bitmap.createBitmap(renderW, renderH, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            drawable.setBounds(0, 0, renderW, renderH)
            drawable.draw(canvas)
            while (bitmap.width >= size * 2 && bitmap.height >= size * 2) {
                val halved = Bitmap.createScaledBitmap(bitmap, bitmap.width / 2, bitmap.height / 2, true)
                bitmap.recycle()
                bitmap = halved
            }
            if (bitmap.width != size || bitmap.height != size) {
                val scaled = Bitmap.createScaledBitmap(bitmap, size, size, true)
                bitmap.recycle()
                bitmap = scaled
            }
            return bitmap
        }

        private fun isDebuggable(service: FaceclawMediaNotificationListenerService): Boolean {
            val flags = service.applicationInfo.flags
            return (flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
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
         * (renderIconScaled), one filtered pass from a much larger source
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

        /**
         * Debug aid for garbled-icon reports: saves each rendered icon to
         * <externalFilesDir>/debug-icons/ (adb-pullable) so extraction problems can
         * be told apart from downstream compositing/transmission problems. Cheap:
         * runs at most once per icon-cache refresh on tiny bitmaps.
         */
        private fun dumpIconDebugPng(service: FaceclawMediaNotificationListenerService, index: Int, packageName: String?, bitmap: Bitmap) {
            if (index < 0) {
                return
            }
            // Debug aid only. Nobody can pull these files out of a release build,
            // and the directory kept one file per icon per index forever.
            if (!isDebuggable(service)) {
                return
            }
            try {
                val dir = java.io.File(service.getExternalFilesDir(null), "debug-icons")
                if (!dir.exists() && !dir.mkdirs()) {
                    return
                }
                if (!debugIconsPruned) {
                    debugIconsPruned = true
                    dir.listFiles()?.forEach { stale -> stale.delete() }
                }
                val safeName = if (packageName == null) "unknown" else packageName.replace(Regex("[^A-Za-z0-9._-]"), "_")
                val file = java.io.File(dir, "icon-$index-$safeName.png")
                java.io.FileOutputStream(file).use { stream ->
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "failed to dump debug icon", t)
            }
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

    override fun onCreate() {
        super.onCreate()
        activeService = this
    }

    override fun onDestroy() {
        if (activeService === this) {
            activeService = null
        }
        super.onDestroy()
    }

    override fun onListenerConnected() {
        activeService = this
        super.onListenerConnected()
        refreshActiveNotificationWakeKeys(this)
    }

    override fun onListenerDisconnected() {
        if (activeService === this) {
            activeService = null
        }
        super.onListenerDisconnected()
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
