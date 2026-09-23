package com.faceclaw.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.util.Log

import androidx.core.graphics.PathParser

import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * Renders a small subset of SVG (the shapes used by Lucide / simple Noun
 * Project icons: path, circle, ellipse, rect, line, polyline, polygon) to a
 * grayscale coverage buffer for use as an on-glasses icon. Icons are stroked
 * (Lucide style: fill="none", 2px stroke, round caps/joins); the returned
 * bytes are one coverage value per pixel (0=transparent .. 255=opaque white),
 * row-major, size*size. Called once per icon and cached on the TS side.
 */
class IconRenderer private constructor() {
    companion object {
        private const val TAG = "IconRenderer"
        private val TAG_RE: Pattern = Pattern.compile("<(path|circle|ellipse|rect|line|polyline|polygon)\\b([^>]*)>")
        private val VIEWBOX_RE: Pattern = Pattern.compile("viewBox\\s*=\\s*\"([^\"]*)\"")
        private val SEPARATOR_RE: Pattern = Pattern.compile("[\\s,]+")

        @JvmStatic
        fun renderSvgGray(svg: String?, size: Int, strokeWidth: Float): ByteArray {
            if (svg == null || size <= 0) {
                return ByteArray(0)
            }
            try {
                var minX = 0f
                var minY = 0f
                var viewW = 24f
                var viewH = 24f
                val vb = VIEWBOX_RE.matcher(svg)
                if (vb.find()) {
                    val parts = SEPARATOR_RE.split(vb.group(1)!!.trim())
                    if (parts.size == 4) {
                        minX = java.lang.Float.parseFloat(parts[0])
                        minY = java.lang.Float.parseFloat(parts[1])
                        viewW = java.lang.Float.parseFloat(parts[2])
                        viewH = java.lang.Float.parseFloat(parts[3])
                    }
                }
                // Lucide-style icons are stroked outlines (fill="none"); everything
                // else (Noun Project glyphs, brand logos) is a filled shape.
                val stroked = svg.contains("fill=\"none\"")
                val path = Path()
                val m = TAG_RE.matcher(svg)
                while (m.find()) {
                    appendElement(path, m.group(1)!!, m.group(2)!!)
                }
                if (path.isEmpty) {
                    return ByteArray(0)
                }

                val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(bitmap)
                val scale = Math.min(size / viewW, size / viewH)
                // Center the (square) viewBox in the bitmap, then map its origin.
                canvas.translate((size - viewW * scale) / 2f, (size - viewH * scale) / 2f)
                canvas.scale(scale, scale)
                canvas.translate(-minX, -minY)
                val paint = Paint(Paint.ANTI_ALIAS_FLAG)
                paint.color = 0xffffffff.toInt()
                if (stroked) {
                    paint.style = Paint.Style.STROKE
                    paint.strokeWidth = strokeWidth
                    paint.strokeCap = Paint.Cap.ROUND
                    paint.strokeJoin = Paint.Join.ROUND
                } else {
                    paint.style = Paint.Style.FILL
                }
                canvas.drawPath(path, paint)

                val pixels = IntArray(size * size)
                bitmap.getPixels(pixels, 0, size, 0, 0, size, size)
                val gray = ByteArray(size * size)
                for (i in pixels.indices) {
                    gray[i] = quantizeCoverage((pixels[i] ushr 24) and 0xff).toByte() // alpha = coverage
                }
                return gray
            } catch (e: Exception) {
                Log.w(TAG, "icon render failed", e)
                return ByteArray(0)
            }
        }

        /**
         * Snap antialiased coverage toward hard edges so the 4bpp frames sent
         * over BLE deflate better: mostly-transparent and mostly-opaque pixels
         * become exactly 0/255 (long runs, and 0 stays color-key transparent for
         * bitBlt), and only genuinely half-covered edge pixels keep one mid gray.
         * The packed frame then uses a 3-symbol alphabet instead of all 16
         * levels, at icon sizes this is visually near-identical.
         */
        @JvmStatic
        private fun quantizeCoverage(alpha: Int): Int {
            if (alpha < 64) return 0
            if (alpha >= 192) return 255
            return 128
        }

        @JvmStatic
        private fun appendElement(path: Path, tag: String, attrs: String) {
            when (tag) {
                "path" -> {
                    val d = attr(attrs, "d")
                    if (d != null) {
                        val sub = PathParser.createPathFromPathData(d)
                        if (sub != null) {
                            path.addPath(sub)
                        }
                    }
                }
                "circle" -> {
                    val cx = num(attrs, "cx", 0f)
                    val cy = num(attrs, "cy", 0f)
                    val r = num(attrs, "r", 0f)
                    if (r > 0) path.addCircle(cx, cy, r, Path.Direction.CW)
                }
                "ellipse" -> {
                    val cx = num(attrs, "cx", 0f)
                    val cy = num(attrs, "cy", 0f)
                    val rx = num(attrs, "rx", 0f)
                    val ry = num(attrs, "ry", 0f)
                    if (rx > 0 && ry > 0) path.addOval(cx - rx, cy - ry, cx + rx, cy + ry, Path.Direction.CW)
                }
                "rect" -> {
                    val x = num(attrs, "x", 0f)
                    val y = num(attrs, "y", 0f)
                    val w = num(attrs, "width", 0f)
                    val h = num(attrs, "height", 0f)
                    var rx = num(attrs, "rx", 0f)
                    var ry = num(attrs, "ry", if (rx > 0) rx else 0f)
                    if (rx <= 0) rx = ry
                    if (ry <= 0) ry = rx
                    if (w > 0 && h > 0) {
                        if (rx > 0 || ry > 0) {
                            path.addRoundRect(x, y, x + w, y + h, rx, ry, Path.Direction.CW)
                        } else {
                            path.addRect(x, y, x + w, y + h, Path.Direction.CW)
                        }
                    }
                }
                "line" -> {
                    path.moveTo(num(attrs, "x1", 0f), num(attrs, "y1", 0f))
                    path.lineTo(num(attrs, "x2", 0f), num(attrs, "y2", 0f))
                }
                "polyline", "polygon" -> {
                    val points = attr(attrs, "points")
                    if (points != null) {
                        val nums = SEPARATOR_RE.split(points.trim())
                        var started = false
                        var i = 0
                        while (i + 1 < nums.size) {
                            val px = java.lang.Float.parseFloat(nums[i])
                            val py = java.lang.Float.parseFloat(nums[i + 1])
                            if (!started) {
                                path.moveTo(px, py)
                                started = true
                            } else {
                                path.lineTo(px, py)
                            }
                            i += 2
                        }
                        if (tag == "polygon") path.close()
                    }
                }
                else -> {
                }
            }
        }

        @JvmStatic
        private fun attr(attrs: String, name: String): String? {
            val m: Matcher = Pattern.compile("\\b" + name + "\\s*=\\s*\"([^\"]*)\"").matcher(attrs)
            return if (m.find()) m.group(1) else null
        }

        @JvmStatic
        private fun num(attrs: String, name: String, fallback: Float): Float {
            val value = attr(attrs, name)
            if (value == null) return fallback
            try {
                return java.lang.Float.parseFloat(value.trim())
            } catch (e: NumberFormatException) {
                return fallback
            }
        }
    }
}
