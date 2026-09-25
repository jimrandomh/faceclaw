package com.faceclaw.app

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.roundToInt

/** Phone-owned policy. Firmware receives only a transient target and fade time. */
class BrightnessPolicy {
    var automatic = true
        private set
    var fadeMs = 280
        private set
    var target = 40
        private set
    private var manual = 50
    private var minimum = 20
    private var maximum = 100
    private var curve = parseCurve(DEFAULT_CURVE)
    private var filteredLux: Double? = null
    private var sampleAt = 0L

    fun setMode(auto: Boolean, level: Int) {
        automatic = auto
        manual = level.coerceIn(2, 100)
        target = if (auto) filteredLux?.let { evaluate(it) } ?: target.coerceIn(minimum, maximum) else manual
    }

    fun configure(auto: Boolean, level: Int, min: Int, max: Int, points: String, fade: Int) {
        val parsed = parseCurve(points) // Validate before mutating the live policy.
        automatic = auto
        manual = level.coerceIn(2, 100)
        minimum = min.coerceIn(2, 100)
        maximum = max.coerceIn(minimum, 100)
        curve = parsed
        fadeMs = fade.coerceIn(0, 1500)
        target = if (auto) filteredLux?.let { evaluate(it) } ?: target.coerceIn(minimum, maximum) else manual
    }

    /** Only live successful passive POLL reports count, never cached query/start reports. */
    fun sample(report: ByteArray, now: Long): Boolean {
        if (report.size < 24 || report[0] != 65.toByte() || report[1] != 76.toByte() ||
            report[2] != 1.toByte() || report[3] != 2.toByte() || (report[4].toInt() and 11) != 11) return false
        var reading = 0L
        for (i in 0..3) reading = reading or ((report[6+i].toLong() and 255) shl (8*i))
        val lux = reading / 10.0
        val old = filteredLux
        val elapsed = (now - sampleAt).coerceAtLeast(0)
        filteredLux = if (old == null || elapsed > 10_000) lux else {
            val seconds = if (lux > old) 0.8 else 3.0
            old + (lux-old) * (1-exp(-elapsed/1000.0/seconds))
        }
        sampleAt = now
        if (!automatic) return false
        val next = evaluate(filteredLux!!)
        // Compare with the last accepted target, not the previous sample, so
        // gradual drift accumulates. Bounds obey the same deadband to avoid
        // extra panel writes when light hovers near the minimum or maximum.
        if (abs(next-target) < AUTO_CHANGE_THRESHOLD) return false
        val changed = target != next
        target = next
        return changed
    }

    fun resetSamples() { filteredLux = null; sampleAt = 0 }

    private fun evaluate(lux: Double): Int {
        val x = ln(1+lux.coerceAtLeast(0.0))
        var fraction = curve.last().second / 100
        if (x <= curve.first().first) fraction = curve.first().second / 100
        else for (i in 1 until curve.size) {
            val (right, high) = curve[i]
            if (x <= right) {
                val (left, low) = curve[i-1]
                fraction = (low + (high-low)*(x-left)/(right-left))/100
                break
            }
        }
        return (minimum+(maximum-minimum)*fraction).roundToInt().coerceIn(minimum, maximum)
    }

    companion object {
        private const val AUTO_CHANGE_THRESHOLD = 5
        const val DEFAULT_CURVE = "0:0,0.2:7,1.5:33,5:100"
        /** Lux:percent-of-configured-range knots; interpolate in log(1+lux). */
        fun parseCurve(text: String): List<Pair<Double, Double>> {
            val entries = text.split(',')
            require(entries.size in 2..16) { "Use 2–16 lux:percent pairs" }
            val points = entries.map {
                val pair = it.trim().split(':')
                require(pair.size == 2) { "Expected lux:percent" }
                val lux = pair[0].trim().toDouble()
                val percent = pair[1].trim().toDouble()
                require(lux.isFinite() && lux in 0.0..1_000_000.0 && percent.isFinite() && percent in 0.0..100.0)
                ln(1+lux) to percent
            }
            require(points.first() == (0.0 to 0.0) && points.last().second == 100.0) { "Start at 0:0 and end at 100%" }
            require(points.zipWithNext().all { (a,b) -> b.first > a.first && b.second >= a.second }) { "Lux must increase and brightness must not decrease" }
            return points
        }
    }
}
