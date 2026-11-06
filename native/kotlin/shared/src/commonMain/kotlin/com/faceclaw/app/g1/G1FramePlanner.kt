package com.faceclaw.app

/**
 * One lens's update on an Even G1: the rectangles that differ from what the arm's frame holds, as RLE bbox calls
 * in draw messages. The transport's deflate runs over these messages, as on the G2; there is no resource cache,
 * so everything visible arrives as pixels.
 */
object G1FramePlanner {
    /** The firmware's limit on a decoded message is 16384 bytes (scouter_kit fc.c MAX_MESSAGE). */
    const val MAX_MESSAGE = 16000

    /** A big rectangle goes out in bands, so that one noisy area doesn't need a long binary split. */
    private const val BAND_ROWS = 32
    private const val MAX_RECTS = ConnectionOptions.MULTI_RECT_MAX_RECTS

    /** [previous] null or of another size: a full frame. Empty when nothing changed. */
    fun plan(previous: ByteArray?, next: ByteArray, width: Int, height: Int): List<ByteArray> {
        val stride = (width + 1) / 2
        require(next.size == stride * height)
        val rects = changedRects(previous, next, width, height)
        if (rects.isEmpty()) return emptyList()
        val calls = ArrayList<ByteArray>()
        for (r in rects) {
            var top = r[1]
            val bottom = r[1] + r[3]
            while (top < bottom) {
                val rows = minOf(BAND_ROWS, bottom - top)
                addRect(calls, next, stride, r[0], top, r[2], rows)
                top += rows
            }
        }
        return DrawProtocol.messages(calls, MAX_MESSAGE)
    }

    private fun changedRects(previous: ByteArray?, next: ByteArray, width: Int, height: Int): List<IntArray> {
        if (previous == null || previous.size != next.size) return listOf(intArrayOf(0, 0, width, height))
        BleImageOptimizer.computeChangedRects(previous, next, width, height, MAX_RECTS)?.let { return it }
        return listOfNotNull(BleImageOptimizer.computeChangedBox(previous, next, width, height))
    }

    /** Splits until the call fits a message; a single pixel always does. */
    private fun addRect(calls: MutableList<ByteArray>, packed: ByteArray, stride: Int, x: Int, y: Int, w: Int, h: Int) {
        val call = DrawProtocol.bbox(packed, stride, x, y, w, h)
        if (call.size + MESSAGE_OVERHEAD <= MAX_MESSAGE) {
            calls.add(call)
        } else if (h > 1) {
            addRect(calls, packed, stride, x, y, w, h / 2)
            addRect(calls, packed, stride, x, y + h / 2, w, h - h / 2)
        } else {
            addRect(calls, packed, stride, x, y, w / 2, h)
            addRect(calls, packed, stride, x + w / 2, y, w - w / 2, h)
        }
    }

    /** The message type, the call count and the call's length (DrawProtocol.sequence). */
    private const val MESSAGE_OVERHEAD = 5
}
