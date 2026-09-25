package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic
import kotlin.math.min

/** One drawable element of a parsed icon; coordinates are in viewBox units. */
sealed class SvgShape {
    class PathData(@JvmField val d: String) : SvgShape()

    class Circle(@JvmField val cx: Float, @JvmField val cy: Float, @JvmField val r: Float) : SvgShape()

    class Ellipse(@JvmField val cx: Float, @JvmField val cy: Float, @JvmField val rx: Float, @JvmField val ry: Float) : SvgShape()

    /** rx/ry are both 0 for a sharp rectangle, otherwise both positive. */
    class Rect(
        @JvmField val x: Float,
        @JvmField val y: Float,
        @JvmField val width: Float,
        @JvmField val height: Float,
        @JvmField val rx: Float,
        @JvmField val ry: Float,
    ) : SvgShape()

    class Line(@JvmField val x1: Float, @JvmField val y1: Float, @JvmField val x2: Float, @JvmField val y2: Float) : SvgShape()

    /** [points] is x0,y0,x1,y1,... with at least one pair; [closed] for polygon. */
    class Polyline(@JvmField val points: FloatArray, @JvmField val closed: Boolean) : SvgShape()
}

class SvgIcon(
    @JvmField val minX: Float,
    @JvmField val minY: Float,
    @JvmField val viewWidth: Float,
    @JvmField val viewHeight: Float,
    /** Lucide-style outline icons (fill="none") are stroked; everything else is filled. */
    @JvmField val stroked: Boolean,
    @JvmField val shapes: List<SvgShape>,
) {
    /**
     * Mapping from viewBox to a size*size raster: [translateX, translateY, scale]. Apply as
     * translate(tx, ty), scale(s), translate(-minX, -minY), i.e. the viewBox centered in the box.
     */
    fun placement(size: Int): FloatArray {
        val scale = min(size / viewWidth, size / viewHeight)
        return floatArrayOf((size - viewWidth * scale) / 2f, (size - viewHeight * scale) / 2f, scale)
    }
}

/**
 * Parses the small subset of SVG used by Lucide / simple Noun Project icons (path, circle,
 * ellipse, rect, line, polyline, polygon) into shapes the platform path builders draw.
 * Also owns the 3-level coverage quantization applied after rasterization on both platforms.
 */
object SvgIconSource {
    private val TAG_RE = Regex("<(path|circle|ellipse|rect|line|polyline|polygon)\\b([^>]*)>")
    private val VIEWBOX_RE = Regex("viewBox\\s*=\\s*\"([^\"]*)\"")
    private val SEPARATOR_RE = Regex("[\\s,]+")

    /** Null when nothing drawable was found. */
    @JvmStatic
    fun parse(svg: String): SvgIcon? {
        var minX = 0f
        var minY = 0f
        var viewW = 24f
        var viewH = 24f
        val vb = VIEWBOX_RE.find(svg)
        if (vb != null) {
            val parts = SEPARATOR_RE.split(vb.groupValues[1].trim())
            if (parts.size == 4) {
                minX = parts[0].toFloat()
                minY = parts[1].toFloat()
                viewW = parts[2].toFloat()
                viewH = parts[3].toFloat()
            }
        }
        val stroked = svg.contains("fill=\"none\"")
        val shapes = ArrayList<SvgShape>()
        for (m in TAG_RE.findAll(svg)) {
            parseElement(m.groupValues[1], m.groupValues[2])?.let { shapes.add(it) }
        }
        if (shapes.isEmpty()) return null
        return SvgIcon(minX, minY, viewW, viewH, stroked, shapes)
    }

    /**
     * Snap antialiased coverage toward hard edges so the 4bpp frames sent over BLE deflate
     * better: mostly-transparent and mostly-opaque pixels become exactly 0/255 (long runs, and
     * 0 stays color-key transparent for bitBlt), and only genuinely half-covered edge pixels
     * keep one mid gray. At icon sizes this is visually near-identical.
     */
    @JvmStatic
    fun quantizeCoverage(alpha: Int): Int {
        if (alpha < 64) return 0
        if (alpha >= 192) return 255
        return 128
    }

    /** Quantized coverage bytes from ARGB pixels (alpha channel = coverage). */
    @JvmStatic
    fun quantizeArgb(pixels: IntArray): ByteArray {
        val gray = ByteArray(pixels.size)
        for (i in pixels.indices) gray[i] = quantizeCoverage((pixels[i] ushr 24) and 0xff).toByte()
        return gray
    }

    private fun parseElement(tag: String, attrs: String): SvgShape? =
        when (tag) {
            "path" -> attr(attrs, "d")?.let { SvgShape.PathData(it) }
            "circle" -> {
                val r = num(attrs, "r", 0f)
                if (r > 0) SvgShape.Circle(num(attrs, "cx", 0f), num(attrs, "cy", 0f), r) else null
            }
            "ellipse" -> {
                val rx = num(attrs, "rx", 0f)
                val ry = num(attrs, "ry", 0f)
                if (rx > 0 && ry > 0) SvgShape.Ellipse(num(attrs, "cx", 0f), num(attrs, "cy", 0f), rx, ry) else null
            }
            "rect" -> {
                val w = num(attrs, "width", 0f)
                val h = num(attrs, "height", 0f)
                var rx = num(attrs, "rx", 0f)
                var ry = num(attrs, "ry", if (rx > 0) rx else 0f)
                if (rx <= 0) rx = ry
                if (ry <= 0) ry = rx
                if (w > 0 && h > 0) {
                    val rounded = rx > 0 || ry > 0
                    SvgShape.Rect(num(attrs, "x", 0f), num(attrs, "y", 0f), w, h, if (rounded) rx else 0f, if (rounded) ry else 0f)
                } else null
            }
            "line" -> SvgShape.Line(num(attrs, "x1", 0f), num(attrs, "y1", 0f), num(attrs, "x2", 0f), num(attrs, "y2", 0f))
            "polyline", "polygon" -> {
                val points = attr(attrs, "points") ?: return null
                val nums = SEPARATOR_RE.split(points.trim())
                val pairs = nums.size / 2
                if (pairs == 0) return null
                val values = FloatArray(pairs * 2) { nums[it].toFloat() }
                SvgShape.Polyline(values, tag == "polygon")
            }
            else -> null
        }

    private fun attr(attrs: String, name: String): String? =
        Regex("\\b" + name + "\\s*=\\s*\"([^\"]*)\"").find(attrs)?.groupValues?.get(1)

    private fun num(attrs: String, name: String, fallback: Float): Float {
        val value = attr(attrs, name) ?: return fallback
        return value.trim().toFloatOrNull() ?: fallback
    }
}
