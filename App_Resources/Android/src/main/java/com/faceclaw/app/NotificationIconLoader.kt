package com.faceclaw.app

import android.app.Notification
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.Icon
import android.os.Build
import android.os.SystemClock
import android.service.notification.StatusBarNotification
import android.util.Log

import com.faceclaw.app.NotificationIconArt.Kind

import java.io.File
import java.io.FileOutputStream

import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Picks and renders the glasses' status-bar icon for a notification (see iconFor).
 * NotificationIconArt does the pixel analysis; this object owns the drawables, package lookups,
 * caching and the debug dump.
 */
internal object NotificationIconLoader {
    private const val TAG = "FaceclawNotifyIcon"

    /** AdaptiveIconDrawable draws its layers this share of the icon's size past each edge. */
    private const val ADAPTIVE_LAYER_OUTSET = 0.25f

    private const val CACHE_MAX_ENTRIES = 128
    /** Cached art is redone after this long, so an updated app's new icon shows up. */
    private const val CACHE_MAX_AGE_MS = 30 * 60 * 1000L

    /** The debug dump keeps at most this many files, deleting the oldest. */
    private const val DEBUG_DUMP_MAX_FILES = 96

    class Rendered(
        /** The drawable it came from: small, monochrome, launcher, foreground, large or letter. */
        val source: String,
        val art: NotificationIconArt.Art,
    )

    /**
     * An app's launcher icon art: its themed monochrome layer, else a glyph or shape read from
     * the icon (or its adaptive foreground layer), else the icon read by brightness.
     */
    private class LauncherArt(val monochrome: Rendered?, val shape: Rendered?, val picture: Rendered?)

    private val smallIconCache = ArtCache<Rendered?>(CACHE_MAX_ENTRIES, CACHE_MAX_AGE_MS)
    private val launcherCache = ArtCache<LauncherArt>(CACHE_MAX_ENTRIES, CACHE_MAX_AGE_MS)

    /**
     * The icon for a notification, size x size gray, from the first of these that works:
     *  1. the small icon, when its alpha carries a shape (nearly every app);
     *  2. the launcher icon's themed monochrome layer (Android 13+), which is made to be tinted;
     *  3. the small icon's glyph, when it is a color tile with one background color;
     *  4. the launcher icon's glyph or shape, or its adaptive foreground layer's shape;
     *  5. the small icon, then the launcher icon, read by brightness;
     *  6. the large icon (usually the sender's avatar: the notification's content, not its app);
     *  7. the app name's initial in a rounded box.
     * Null only when even the initial can't be drawn.
     */
    fun iconFor(context: Context, statusBarNotification: StatusBarNotification, size: Int, appName: () -> String): Rendered? {
        val packageName = statusBarNotification.packageName ?: ""
        val notification = statusBarNotification.notification
        val small = smallIconArt(context, packageName, notification.smallIcon, size)
        val smallKind = small?.art?.kind
        if (smallKind == Kind.TEMPLATE || smallKind == Kind.SOLID) return small
        val launcher = launcherArt(context, packageName, size)
        launcher.monochrome?.let { return it }
        if (smallKind == Kind.GLYPH) return small
        launcher.shape?.let { return it }
        if (smallKind == Kind.PICTURE) return small
        launcher.picture?.let { return it }
        largeIconArt(context, packageName, notification, size)?.let { return it }
        return letterArt(appName(), size)
    }

    private fun smallIconArt(context: Context, packageName: String, icon: Icon?, size: Int): Rendered? {
        if (icon == null) return null
        val key = resourceKey(icon) ?: return loadSmallIcon(context, packageName, icon, size)
        return smallIconCache.getOrPut("$packageName|$key|$size") { loadSmallIcon(context, packageName, icon, size) }
    }

    /** Resource icons are cached by resource; bitmap and URI icons are converted every time. */
    private fun resourceKey(icon: Icon): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P || icon.type != Icon.TYPE_RESOURCE) return null
        return icon.resPackage + "/" + icon.resId
    }

    private fun loadSmallIcon(context: Context, packageName: String, icon: Icon, size: Int): Rendered? =
        tryRender("small", packageName) {
            val drawable = icon.loadDrawable(context) ?: return@tryRender null
            // A tint (the Icon's own, or a vector's theme tint) recolors the very pixels that tell
            // a template from a color tile, and can fade a template's alpha. Templates are read
            // by alpha alone, so dropping it costs nothing.
            drawable.mutate()
            drawable.setTintList(null)
            renderSource(context, packageName, "small", drawable, size)
        }

    private fun launcherArt(context: Context, packageName: String, size: Int): LauncherArt =
        launcherCache.getOrPut("$packageName|$size") { loadLauncherArt(context, packageName, size) }

    private fun loadLauncherArt(context: Context, packageName: String, size: Int): LauncherArt {
        val icon: Drawable = try {
            context.packageManager.getApplicationIcon(packageName)
        } catch (t: Throwable) {
            Log.w(TAG, "no launcher icon for $packageName", t)
            return LauncherArt(null, null, null)
        }
        val adaptive = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) icon as? AdaptiveIconDrawable else null
        if (adaptive != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val layer = adaptive.monochrome
            val monochrome = if (layer == null) null else tryRender("monochrome", packageName) {
                renderSource(context, packageName, "monochrome", layer, size, ADAPTIVE_LAYER_OUTSET, template = true)
            }
            if (monochrome != null) return LauncherArt(monochrome, null, null)
        }
        val whole = tryRender("launcher", packageName) { renderSource(context, packageName, "launcher", icon, size) }
        var shape = whole?.takeIf { it.art.kind == Kind.TEMPLATE || it.art.kind == Kind.GLYPH }
        val foreground = adaptive?.foreground
        if (shape == null && foreground != null) {
            // A gradient or picture background hides the glyph; the foreground layer alone may carry it as alpha.
            shape = tryRender("foreground", packageName) {
                renderSource(context, packageName, "foreground", foreground, size, ADAPTIVE_LAYER_OUTSET)
            }?.takeIf { it.art.kind == Kind.TEMPLATE }
        }
        return LauncherArt(null, shape, whole?.takeIf { it.art.kind == Kind.PICTURE })
    }

    private fun largeIconArt(context: Context, packageName: String, notification: Notification, size: Int): Rendered? =
        tryRender("large", packageName) {
            val drawable = notification.getLargeIcon()?.loadDrawable(context) ?: return@tryRender null
            renderSource(context, packageName, "large", drawable, size)
        }

    /** The app name's first letter or digit in a rounded box, like the shell's letter window icons. */
    private fun letterArt(appName: String, size: Int): Rendered? = tryRender("letter", appName) {
        val letter = appName.firstOrNull { it.isLetterOrDigit() }?.uppercaseChar()?.toString() ?: "?"
        val canvasSize = size * NotificationIconArt.ANALYSIS_SCALE
        val bitmap = Bitmap.createBitmap(canvasSize, canvasSize, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val stroke = NotificationIconArt.ANALYSIS_SCALE.toFloat()
        val box = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = stroke
            color = Color.argb(160, 255, 255, 255)
        }
        val radius = canvasSize / 4f
        canvas.drawRoundRect(stroke / 2, stroke / 2, canvasSize - stroke / 2, canvasSize - stroke / 2, radius, radius, box)
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            typeface = Typeface.DEFAULT_BOLD
            textSize = canvasSize * 0.6f
            textAlign = Paint.Align.CENTER
        }
        val bounds = Rect()
        text.getTextBounds(letter, 0, letter.length, bounds)
        canvas.drawText(letter, canvasSize / 2f, canvasSize / 2f - bounds.exactCenterY(), text)
        val argb = IntArray(canvasSize * canvasSize)
        bitmap.getPixels(argb, 0, canvasSize, 0, 0, canvasSize, canvasSize)
        bitmap.recycle()
        val art = NotificationIconArt.template(argb, size)
        if (art.kind == Kind.EMPTY) null else Rendered("letter", art)
    }

    private inline fun tryRender(source: String, owner: String, render: () -> Rendered?): Rendered? {
        return try {
            render()
        } catch (t: Throwable) {
            Log.w(TAG, "failed to render $source icon for $owner", t)
            null
        }
    }

    /** Render, dump and convert one source drawable; null when nothing visible came out. */
    private fun renderSource(
        context: Context, packageName: String, source: String, drawable: Drawable, size: Int,
        outset: Float = 0f, template: Boolean = false,
    ): Rendered? {
        val analysisSize = size * NotificationIconArt.ANALYSIS_SCALE
        val argb = renderArgb(drawable, analysisSize, outset)
        dumpDebugPng(context, packageName, source, argb, analysisSize)
        val art = if (template) NotificationIconArt.template(argb, size) else NotificationIconArt.convert(argb, size)
        return if (art.kind == Kind.EMPTY) null else Rendered(source, art)
    }

    /**
     * Render a drawable to target x target ARGB with proper downscaling. Detailed sources (e.g.
     * avatar bitmaps used as notification icons) are rendered at native resolution and reduced
     * by repeated halving: a single filtered pass from, say, 126px to 24px samples too sparsely
     * and turns fine detail into speckle that reads as a garbled icon. An outset draws the
     * drawable that share of the canvas past each edge, as AdaptiveIconDrawable draws its layers.
     */
    private fun renderArgb(drawable: Drawable, target: Int, outset: Float): IntArray {
        drawable.mutate()
        if (drawable is BitmapDrawable) {
            drawable.setFilterBitmap(true)
        }
        val scale = 1f + 2f * outset
        val renderW = max(target, (drawable.intrinsicWidth / scale).roundToInt())
        val renderH = max(target, (drawable.intrinsicHeight / scale).roundToInt())
        var bitmap = Bitmap.createBitmap(renderW, renderH, Bitmap.Config.ARGB_8888)
        val dx = (renderW * outset).roundToInt()
        val dy = (renderH * outset).roundToInt()
        drawable.setBounds(-dx, -dy, renderW + dx, renderH + dy)
        drawable.draw(Canvas(bitmap))
        while (bitmap.width >= target * 2 && bitmap.height >= target * 2) {
            val halved = Bitmap.createScaledBitmap(bitmap, bitmap.width / 2, bitmap.height / 2, true)
            bitmap.recycle()
            bitmap = halved
        }
        if (bitmap.width != target || bitmap.height != target) {
            val scaled = Bitmap.createScaledBitmap(bitmap, target, target, true)
            bitmap.recycle()
            bitmap = scaled
        }
        val pixels = IntArray(target * target)
        bitmap.getPixels(pixels, 0, target, 0, 0, target, target)
        bitmap.recycle()
        return pixels
    }

    /**
     * Debug aid for icon reports: saves each source as rendered for analysis, before any
     * conversion, to <externalFilesDir>/debug-icons/<package>-<source>.png (adb-pullable), so a
     * bad icon can be rerun through NotificationIconArt off-device. Runs only when a source is
     * converted, not on cached icons; the oldest files past DEBUG_DUMP_MAX_FILES are deleted.
     */
    private fun dumpDebugPng(context: Context, packageName: String, source: String, argb: IntArray, size: Int) {
        try {
            val base = context.getExternalFilesDir(null) ?: return
            val dir = File(base, "debug-icons")
            if (!dir.exists() && !dir.mkdirs()) {
                return
            }
            val safeName = packageName.replace(Regex("[^A-Za-z0-9._-]"), "_")
            val bitmap = Bitmap.createBitmap(argb, size, size, Bitmap.Config.ARGB_8888)
            try {
                FileOutputStream(File(dir, "$safeName-$source.png")).use { stream ->
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
                }
            } finally {
                bitmap.recycle()
            }
            val files = dir.listFiles() ?: return
            if (files.size > DEBUG_DUMP_MAX_FILES) {
                files.sortBy { it.lastModified() }
                for (index in 0 until files.size - DEBUG_DUMP_MAX_FILES) {
                    files[index].delete()
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "failed to dump debug icon", t)
        }
    }

    /** A small LRU of converted art with an age limit. Conversions run under its lock. */
    private class ArtCache<V>(private val maxEntries: Int, private val maxAgeMs: Long) {
        private class Entry<T>(val value: T, val atMs: Long)

        private val entries = object : LinkedHashMap<String, Entry<V>>(16, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry<V>>): Boolean {
                return size > maxEntries
            }
        }

        @Synchronized
        fun getOrPut(key: String, compute: () -> V): V {
            val now = SystemClock.elapsedRealtime()
            val cached = entries[key]
            if (cached != null && now - cached.atMs < maxAgeMs) {
                return cached.value
            }
            val value = compute()
            entries[key] = Entry(value, now)
            return value
        }
    }
}
