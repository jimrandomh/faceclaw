package com.faceclaw.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.util.Log

import androidx.core.graphics.PathParser

/**
 * Renders a small subset of SVG (the shapes used by Lucide / simple Noun
 * Project icons: path, circle, ellipse, rect, line, polyline, polygon) to a
 * grayscale coverage buffer for use as an on-glasses icon. Icons are stroked
 * (Lucide style: fill="none", 2px stroke, round caps/joins); the returned
 * bytes are one coverage value per pixel (0=transparent .. 255=opaque white),
 * row-major, size*size. Called once per icon and cached on the TS side.
 *
 * Parsing, placement math and the coverage quantization are shared with iOS
 * (SvgIconSource); this class only maps shapes onto android.graphics.Path and
 * rasterizes them.
 */
class IconRenderer private constructor() {
    companion object {
        private const val TAG = "IconRenderer"

        @JvmStatic
        fun renderSvgGray(svg: String?, size: Int, strokeWidth: Float): ByteArray {
            if (svg == null || size <= 0) {
                return ByteArray(0)
            }
            try {
                val icon = SvgIconSource.parse(svg) ?: return ByteArray(0)
                val path = Path()
                for (shape in icon.shapes) {
                    appendShape(path, shape)
                }
                if (path.isEmpty) {
                    return ByteArray(0)
                }

                val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(bitmap)
                // Center the (square) viewBox in the bitmap, then map its origin.
                val placement = icon.placement(size)
                canvas.translate(placement[0], placement[1])
                canvas.scale(placement[2], placement[2])
                canvas.translate(-icon.minX, -icon.minY)
                val paint = Paint(Paint.ANTI_ALIAS_FLAG)
                paint.color = 0xffffffff.toInt()
                if (icon.stroked) {
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
                return SvgIconSource.quantizeArgb(pixels) // alpha = coverage
            } catch (e: Exception) {
                Log.w(TAG, "icon render failed", e)
                return ByteArray(0)
            }
        }

        @JvmStatic
        private fun appendShape(path: Path, shape: SvgShape) {
            when (shape) {
                is SvgShape.PathData -> {
                    val sub = PathParser.createPathFromPathData(shape.d)
                    if (sub != null) {
                        path.addPath(sub)
                    }
                }
                is SvgShape.Circle -> path.addCircle(shape.cx, shape.cy, shape.r, Path.Direction.CW)
                is SvgShape.Ellipse -> path.addOval(
                        shape.cx - shape.rx, shape.cy - shape.ry, shape.cx + shape.rx, shape.cy + shape.ry, Path.Direction.CW)
                is SvgShape.Rect -> {
                    if (shape.rx > 0 || shape.ry > 0) {
                        path.addRoundRect(shape.x, shape.y, shape.x + shape.width, shape.y + shape.height,
                                shape.rx, shape.ry, Path.Direction.CW)
                    } else {
                        path.addRect(shape.x, shape.y, shape.x + shape.width, shape.y + shape.height, Path.Direction.CW)
                    }
                }
                is SvgShape.Line -> {
                    path.moveTo(shape.x1, shape.y1)
                    path.lineTo(shape.x2, shape.y2)
                }
                is SvgShape.Polyline -> {
                    val p = shape.points
                    path.moveTo(p[0], p[1])
                    var i = 2
                    while (i + 1 < p.size) {
                        path.lineTo(p[i], p[i + 1])
                        i += 2
                    }
                    if (shape.closed) path.close()
                }
            }
        }
    }
}
