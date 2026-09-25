package com.faceclaw.app

import kotlin.jvm.JvmStatic
import kotlin.math.abs

/**
 * Pure 24x24 8bpp icons for the system status strip (Wi-Fi level, cellular level, hotspot).
 * Platform code reads the levels; this object only draws, so both platforms render the same
 * artwork.
 */
object StatusIconArt {
    const val ICON_SIZE = 24

    @JvmStatic
    fun wifi(level: Int): ByteArray {
        val icon = ByteArray(ICON_SIZE * ICON_SIZE)
        val cx = 12
        val cy = 18
        fillRect(icon, cx - 1, cy - 1, 3, 3, 230)
        val radii = intArrayOf(5, 9, 13, 17)
        for (index in radii.indices) {
            if (level <= index) {
                continue
            }
            drawWifiArc(icon, cx, cy, radii[index], 210)
        }
        return icon
    }

    @JvmStatic
    fun cell(level: Int): ByteArray {
        val icon = ByteArray(ICON_SIZE * ICON_SIZE)
        for (bar in 0 until 4) {
            val x = 5 + bar * 4
            val height = 5 + bar * 4
            val value = if (level > bar) 220 else 55
            fillRect(icon, x, 20 - height, 3, height, value)
        }
        return icon
    }

    @JvmStatic
    fun hotspot(): ByteArray {
        val icon = ByteArray(ICON_SIZE * ICON_SIZE)
        fillRect(icon, 11, 17, 3, 3, 230)
        drawWifiArc(icon, 12, 19, 7, 210)
        drawWifiArc(icon, 12, 19, 12, 210)
        fillRect(icon, 6, 5, 12, 2, 170)
        return icon
    }

    /** Nearest-neighbour resample of a 24x24 icon to size x size. */
    @JvmStatic
    fun scale(source: ByteArray, size: Int): ByteArray {
        if (size == ICON_SIZE) {
            return source
        }
        val scaled = ByteArray(size * size)
        for (y in 0 until size) {
            val sy = minOf(ICON_SIZE - 1, (y * ICON_SIZE) / size)
            for (x in 0 until size) {
                val sx = minOf(ICON_SIZE - 1, (x * ICON_SIZE) / size)
                scaled[y * size + x] = source[sy * ICON_SIZE + sx]
            }
        }
        return scaled
    }

    private fun drawWifiArc(icon: ByteArray, cx: Int, cy: Int, radius: Int, value: Int) {
        val inner = (radius - 1) * (radius - 1)
        val outer = (radius + 1) * (radius + 1)
        for (y in 0 until ICON_SIZE) {
            for (x in 0 until ICON_SIZE) {
                val dx = x - cx
                val dy = y - cy
                val dist = dx * dx + dy * dy
                if (dy <= 0 && dist >= inner && dist <= outer && abs(dx) <= radius) {
                    setPixel(icon, x, y, value)
                }
            }
        }
    }

    private fun fillRect(icon: ByteArray, x: Int, y: Int, width: Int, height: Int, value: Int) {
        for (row in y until y + height) {
            for (col in x until x + width) {
                setPixel(icon, col, row, value)
            }
        }
    }

    private fun setPixel(icon: ByteArray, x: Int, y: Int, value: Int) {
        if (x < 0 || y < 0 || x >= ICON_SIZE || y >= ICON_SIZE) {
            return
        }
        icon[y * ICON_SIZE + x] = value.coerceIn(0, 255).toByte()
    }
}
