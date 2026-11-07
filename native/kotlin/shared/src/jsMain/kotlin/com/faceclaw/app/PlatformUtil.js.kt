package com.faceclaw.app

import kotlin.js.Date

/** Pure Kotlin SHA-256: the only platform digest (SubtleCrypto) is asynchronous. */
actual class Sha256Digest actual constructor() {
    private val h = intArrayOf(
        0x6a09e667, -0x4498517b, 0x3c6ef372, -0x5ab00ac6, 0x510e527f, -0x64fa9774, 0x1f83d9ab, 0x5be0cd19,
    )
    private val block = ByteArray(64)
    private var blockLength = 0
    private var total = 0L
    private var finished = false

    actual fun update(bytes: ByteArray, offset: Int, length: Int) {
        check(!finished) { "digest already finished" }
        total += length
        for (i in offset until offset + length) {
            block[blockLength++] = bytes[i]
            if (blockLength == 64) {
                compress()
                blockLength = 0
            }
        }
    }

    actual fun digest(): ByteArray {
        check(!finished) { "digest already finished" }
        finished = true
        val bits = total * 8
        block[blockLength++] = 0x80.toByte()
        if (blockLength > 56) {
            block.fill(0, blockLength, 64)
            compress()
            blockLength = 0
        }
        block.fill(0, blockLength, 56)
        for (i in 0 until 8) block[56 + i] = (bits shr (56 - i * 8)).toByte()
        compress()
        val out = ByteArray(32)
        for (i in 0 until 8) for (b in 0 until 4) out[i * 4 + b] = (h[i] ushr (24 - b * 8)).toByte()
        return out
    }

    private fun compress() {
        val w = IntArray(64)
        for (i in 0 until 16) {
            w[i] = ((block[i * 4].toInt() and 0xff) shl 24) or ((block[i * 4 + 1].toInt() and 0xff) shl 16) or
                ((block[i * 4 + 2].toInt() and 0xff) shl 8) or (block[i * 4 + 3].toInt() and 0xff)
        }
        for (i in 16 until 64) {
            val s0 = w[i - 15].rotateRight(7) xor w[i - 15].rotateRight(18) xor (w[i - 15] ushr 3)
            val s1 = w[i - 2].rotateRight(17) xor w[i - 2].rotateRight(19) xor (w[i - 2] ushr 10)
            w[i] = w[i - 16] + s0 + w[i - 7] + s1
        }
        var a = h[0]
        var b = h[1]
        var c = h[2]
        var d = h[3]
        var e = h[4]
        var f = h[5]
        var g = h[6]
        var hh = h[7]
        for (i in 0 until 64) {
            val s1 = e.rotateRight(6) xor e.rotateRight(11) xor e.rotateRight(25)
            val ch = (e and f) xor (e.inv() and g)
            val t1 = hh + s1 + ch + K[i] + w[i]
            val s0 = a.rotateRight(2) xor a.rotateRight(13) xor a.rotateRight(22)
            val maj = (a and b) xor (a and c) xor (b and c)
            val t2 = s0 + maj
            hh = g
            g = f
            f = e
            e = d + t1
            d = c
            c = b
            b = a
            a = t1 + t2
        }
        h[0] += a
        h[1] += b
        h[2] += c
        h[3] += d
        h[4] += e
        h[5] += f
        h[6] += g
        h[7] += hh
    }

    private companion object {
        val K = intArrayOf(
            0x428a2f98, 0x71374491, -0x4a3f0431, -0x164a245b, 0x3956c25b, 0x59f111f1, -0x6dc07d5c, -0x54e3a12b,
            -0x27f85568, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, -0x7f214e02, -0x6423f959, -0x3e640e8c,
            -0x1b64963f, -0x1041b87a, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            -0x67c1aeae, -0x57ce3993, -0x4ffcd838, -0x40a68039, -0x391ff40d, -0x2a586eb9, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, -0x7e3d36d2, -0x6d8dd37b,
            -0x5d40175f, -0x57e599b5, -0x3db47490, -0x3893ae5d, -0x2e6d17e7, -0x2966f9dc, -0x0bf1ca7b, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, -0x7b3787ec, -0x7338fdf8, -0x6f410006, -0x5baf9315, -0x41065c09, -0x398e870e,
        )
    }
}

actual fun currentTimeMillis(): Long = Date.now().toLong()

private fun pad(value: Int, width: Int = 2): String = value.toString().padStart(width, '0')

/** The handful of SimpleDateFormat letters Kotlin callers use. */
actual fun formatLocalTime(epochMs: Long, pattern: String): String {
    val date = Date(epochMs.toDouble())
    val out = StringBuilder()
    var i = 0
    while (i < pattern.length) {
        val letter = pattern[i]
        var run = 1
        while (i + run < pattern.length && pattern[i + run] == letter) run++
        when (letter) {
            'y' -> out.append(pad(date.getFullYear(), run))
            'M' -> out.append(pad(date.getMonth() + 1, run))
            'd' -> out.append(pad(date.getDate(), run))
            'H' -> out.append(pad(date.getHours(), run))
            'm' -> out.append(pad(date.getMinutes(), run))
            's' -> out.append(pad(date.getSeconds(), run))
            'S' -> out.append(pad(date.getMilliseconds(), run))
            else -> repeat(run) { out.append(letter) }
        }
        i += run
    }
    return out.toString()
}

actual fun localUtcOffsetMs(epochMs: Long): Int = -Date(epochMs.toDouble()).getTimezoneOffset() * 60_000

actual fun localTimeZoneId(): String = js("Intl.DateTimeFormat().resolvedOptions().timeZone").unsafeCast<String>()

actual object PlatformLog {
    actual fun i(tag: String, message: String) = console.log("$tag: $message")

    actual fun w(tag: String, message: String) = console.warn("$tag: $message")

    actual fun e(tag: String, message: String, error: Throwable?) =
        console.error("$tag: $message" + (error?.let { " (${it.message})" } ?: ""))
}

actual fun startThread(name: String, daemon: Boolean, body: () -> Unit) {
    throw UnsupportedOperationException("No threads in the browser: $name")
}

actual fun sleepMs(ms: Long) {
    throw UnsupportedOperationException("No blocking sleep in the browser")
}
