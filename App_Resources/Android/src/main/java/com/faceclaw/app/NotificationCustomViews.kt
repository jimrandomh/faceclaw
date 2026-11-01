package com.faceclaw.app

import android.app.Notification
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Picture
import android.os.Build
import android.service.notification.StatusBarNotification
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.RemoteViews
import android.widget.TextView

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * A notification's custom layout (RemoteViews), which can carry what its standard fields leave
 * out: Dexcom's G7 notification has no title or text at all, just a layout with the glucose
 * reading and trend arrow. Inflated here the way the shade does it, for its text (a stand-in
 * title in lists) and to draw it as a picture.
 */
internal object NotificationCustomViews {
    private const val TAG = "FaceclawNotifyView"
    /** Set by Notification.Builder when the app gave it a custom layout (Notification.EXTRA_CONTAINS_CUSTOM_VIEW, hidden). */
    private const val EXTRA_CONTAINS_CUSTOM_VIEW = "android.contains.customView"
    private const val VIEW_CACHE_MAX_ENTRIES = 8
    private const val TEXT_CACHE_MAX_ENTRIES = 64
    /** Layouts are cut off below this height, in dp; the shade caps an expanded notification at 256. */
    private const val MAX_HEIGHT_DP = 320

    /** Inflated layouts by notification post and layout; null when inflating failed, so it isn't retried every paint. */
    private val views = Lru<View?>(VIEW_CACHE_MAX_ENTRIES)
    private val texts = Lru<List<String>>(TEXT_CACHE_MAX_ENTRIES)

    /**
     * Whether the app gave the notification a custom layout. The flag tells one apart from the
     * standard template that Notification.Builder stores in contentView for apps targeting
     * Android 6 and older, which only repeats the title and text.
     */
    @Suppress("DEPRECATION")
    fun hasCustomView(notification: Notification): Boolean {
        val extras = notification.extras ?: return false
        return extras.getBoolean(EXTRA_CONTAINS_CUSTOM_VIEW)
            && (notification.contentView != null || notification.bigContentView != null || notification.headsUpContentView != null)
    }

    /**
     * The text of the custom layout as collapsed in the shade, one entry per visible TextView in
     * layout order; empty without a custom layout. Cached per post of the notification.
     */
    @Synchronized
    fun texts(context: Context, statusBarNotification: StatusBarNotification): List<String> {
        val notification = statusBarNotification.notification ?: return emptyList()
        val (name, layout) = layoutFor(notification, expanded = false) ?: return emptyList()
        return texts.getOrPut(postKey(statusBarNotification, name)) {
            inflate(context, statusBarNotification, name, layout)?.let { collectTexts(it, ArrayList()) } ?: emptyList()
        }
    }

    /**
     * The custom layout drawn as a gray packet fitting maxWidth x maxHeight; empty without one
     * or when it can't be drawn. It is laid out maxWidth dp wide and shown at no more than a
     * glasses pixel per dp, where the shade's text sizes land near the glasses' UI font, then
     * trimmed to what it draws. The collapsed layout is used when the notification has a
     * picture to show under it (an expanded layout tends to repeat the picture, as Dexcom's
     * does), else the expanded one. Ink drawn for a light background comes out light on dark.
     */
    @Synchronized
    fun renderGray(
        context: Context, statusBarNotification: StatusBarNotification, expanded: Boolean,
        maxWidth: Int, maxHeight: Int, gamma: Float, dither: Boolean,
    ): ByteArray {
        val notification = statusBarNotification.notification ?: return ByteArray(0)
        if (maxWidth <= 0 || maxHeight <= 0) return ByteArray(0)
        val (name, layout) = layoutFor(notification, expanded) ?: return ByteArray(0)
        val view = inflate(context, statusBarNotification, name, layout) ?: return ByteArray(0)
        try {
            val density = context.resources.displayMetrics.density
            val widthPx = max(1, (maxWidth * density).roundToInt())
            val maxHeightPx = max(1, (MAX_HEIGHT_DP * density).roundToInt())
            view.measure(
                View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            if (view.measuredHeight > maxHeightPx) {
                view.measure(
                    View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(maxHeightPx, View.MeasureSpec.AT_MOST))
            }
            val heightPx = min(view.measuredHeight, maxHeightPx)
            if (heightPx <= 0) return ByteArray(0)
            view.layout(0, 0, widthPx, heightPx)

            val drawn = drawView(view, widthPx, heightPx)
            val pixels = IntArray(widthPx * heightPx)
            drawn.getPixels(pixels, 0, widthPx, 0, 0, widthPx, heightPx)
            drawn.recycle()
            val bounds = GrayPacket.inkBounds(pixels, widthPx, heightPx) ?: return ByteArray(0)
            val cropWidth = bounds[2] - bounds[0]
            val cropHeight = bounds[3] - bounds[1]
            val cropped = IntArray(cropWidth * cropHeight)
            for (y in 0 until cropHeight) {
                System.arraycopy(pixels, (bounds[1] + y) * widthPx + bounds[0], cropped, y * cropWidth, cropWidth)
            }
            GrayPacket.lightenDarkInk(cropped, cropWidth, cropHeight)
            val art = Bitmap.createBitmap(cropped, cropWidth, cropHeight, Bitmap.Config.ARGB_8888)
            // A dp per glasses pixel at most: bitmapToGrayPacket otherwise blows a narrow layout up to the box.
            val fitWidth = min(maxWidth, ceil(cropWidth / density).toInt())
            val fitHeight = min(maxHeight, ceil(cropHeight / density).toInt())
            Log.i(TAG, "rendered $name layout of ${statusBarNotification.packageName}: ${cropWidth}x$cropHeight px"
                + " into ${fitWidth}x$fitHeight")
            return ImageFileLoader.bitmapToGrayPacket(
                FaceclawMediaNotificationListenerService.halveToward(art, fitWidth, fitHeight),
                fitWidth, fitHeight, gamma, dither, true)
        } catch (t: Throwable) {
            Log.w(TAG, "failed to draw the $name layout of ${statusBarNotification.packageName}", t)
            return ByteArray(0)
        }
    }

    /**
     * The custom layout to use, with the field it came from: the collapsed one (contentView)
     * or the expanded one (bigContentView), falling back on the other, then on the heads-up one.
     */
    @Suppress("DEPRECATION")
    private fun layoutFor(notification: Notification, expanded: Boolean): Pair<String, RemoteViews>? {
        if (!hasCustomView(notification)) return null
        val collapsed = notification.contentView?.let { "content" to it }
        val big = notification.bigContentView?.let { "big" to it }
        val first = if (expanded) big ?: collapsed else collapsed ?: big
        return first ?: notification.headsUpContentView?.let { "headsUp" to it }
    }

    /** A notification is reposted (with a new postTime) whenever its app updates it. */
    private fun postKey(statusBarNotification: StatusBarNotification, layoutName: String): String =
        "${statusBarNotification.key}|${statusBarNotification.postTime}|$layoutName"

    private fun inflate(context: Context, statusBarNotification: StatusBarNotification, name: String, layout: RemoteViews): View? =
        views.getOrPut(postKey(statusBarNotification, name)) {
            try {
                // RemoteViews loads the layout and its resources from the posting app's package.
                layout.apply(context, FrameLayout(context))
            } catch (t: Throwable) {
                Log.w(TAG, "failed to inflate the $name layout of ${statusBarNotification.packageName}", t)
                null
            }
        }

    private fun collectTexts(view: View, out: MutableList<String>): List<String> {
        if (view.visibility != View.VISIBLE) return out
        if (view is TextView) {
            val text = view.text?.toString()?.replace(Regex("\\s+"), " ")?.trim() ?: ""
            if (text.isNotEmpty()) out.add(text)
        } else if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                collectTexts(view.getChildAt(index), out)
            }
        }
        return out
    }

    /**
     * Draws a laid-out view to a software bitmap. From Android 9 this goes through a Picture,
     * which (unlike a bitmap's Canvas) accepts the hardware bitmaps a layout's images can
     * arrive as; Bitmap.createBitmap then renders it on the GPU and reads it back if it has to.
     */
    private fun drawView(view: View, width: Int, height: Int): Bitmap {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val picture = Picture()
            view.draw(picture.beginRecording(width, height))
            picture.endRecording()
            return Bitmap.createBitmap(picture, width, height, Bitmap.Config.ARGB_8888)
        }
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        return bitmap
    }

    /** A small LRU map; values may be null. Callers hold the object's lock. */
    private class Lru<V>(private val maxEntries: Int) {
        private val entries = object : LinkedHashMap<String, V>(16, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, V>): Boolean = size > maxEntries
        }

        fun getOrPut(key: String, compute: () -> V): V {
            if (entries.containsKey(key)) {
                @Suppress("UNCHECKED_CAST")
                return entries[key] as V
            }
            val value = compute()
            entries[key] = value
            return value
        }
    }
}
