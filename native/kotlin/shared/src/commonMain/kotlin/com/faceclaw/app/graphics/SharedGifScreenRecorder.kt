package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.math.roundToLong

/**
 * Accumulates composited screen frames and saves them as a looping animated GIF with a 16-entry
 * grayscale palette. Stored frames are deflate-compressed (a typical UI frame shrinks from 166KB of
 * indices to a few KB) so long recordings stay affordable in memory; consecutive identical frames
 * are deduplicated, with the elapsed time folded into the next frame's delay.
 */
class SharedGifScreenRecorder {
    private val lock = protocolPlatform().createLock()

    fun encode(): ByteArray = lock.withLock {
        if (frames.isEmpty()) return ByteArray(0)
        val out = ByteSink()
        writeGif(out)
        out.toByteArray()
    }

    companion object {
        /** Backstop against unbounded growth if a recording is left running. */
        private const val MAX_FRAMES: Int = 3600

        /** Displayed duration of the final frame, which has no successor. */
        private const val LAST_FRAME_DELAY_CS: Int = 100

        /** Below this, GIF renderers historically clamp or ignore the delay. */
        private const val MIN_FRAME_DELAY_CS: Int = 2

        /** GIF LZW compression of a 4-bit index stream (minimum code size 4). */
        private fun writeLzwImageData(out: ByteSink, indices: ByteArray): Unit {
            val minCodeSize: Int = 4
            out.write(minCodeSize)
            var writer: SubBlockBitWriter = SubBlockBitWriter(out)
            val clearCode: Int = (1 shl minCodeSize)
            val eoiCode: Int = (clearCode + 1)
            var codeSize: Int = (minCodeSize + 1)
            var nextCode: Int = (eoiCode + 1)
            var table: HashMap<Int, Int> = HashMap()
            writer.writeCode(clearCode, codeSize)
            var prefix: Int = (indices[0] and 0xff)
            run {
                var i: Int = 1
                while ((i < indices.size)) {
                    var k: Int = (indices[i] and 0xff)
                    var key: Int = ((prefix shl 8) or k)
                    var code: Int? = table.get(key)
                    if ((code != null)) {
                        prefix = code
                        i++
                        continue
                    }
                    writer.writeCode(prefix, codeSize)
                    if ((nextCode == 0x1000)) {
                        writer.writeCode(clearCode, codeSize)
                        table.clear()
                        codeSize = (minCodeSize + 1)
                        nextCode = (eoiCode + 1)
                    } else {
                        if ((nextCode >= (1 shl codeSize))) {
                            codeSize++
                        }
                        table.put(key, nextCode++)
                    }
                    prefix = k
                    i++
                }
            }
            writer.writeCode(prefix, codeSize)
            writer.writeCode(eoiCode, codeSize)
            writer.finish()
        }

        private fun writeShortLE(out: ByteSink, value: Int): Unit {
            out.write((value and 0xff))
            out.write(((value ushr 8) and 0xff))
        }
    }

    private class Frame {
        @JvmField val deflatedIndices: ByteArray

        @JvmField val timestampMs: Long

        constructor(deflatedIndices: ByteArray, timestampMs: Long) {
            this.deflatedIndices = deflatedIndices
            this.timestampMs = timestampMs
        }
    }

    private val frames: MutableList<Frame> = ArrayList()

    /** Undeflated copy of the newest frame, kept for duplicate detection. */
    private var lastIndices: ByteArray? = null

    private var width: Int = 0

    private var height: Int = 0

    private var overflowed: Boolean = false

    /**
     * Append the current screen. gray is 8bpp; only the top nibble (the display's native depth, and
     * the palette index) is kept.
     */
    fun addFrame(gray: ByteArray?, width: Int, height: Int, timestampMs: Long): Unit {
        lock.withLock {
            if (
                ((((gray == null) || (width <= 0)) || (height <= 0)) ||
                    (gray.size < (width * height)))
            ) {
                return
            }
            if (frames.isEmpty()) {
                this.width = width
                this.height = height
            } else {
                if (((width != this.width) || (height != this.height))) {
                    return
                }
            }
            var indices: ByteArray = ByteArray((width * height))
            run {
                var i: Int = 0
                while ((i < indices.size)) {
                    indices[i] = (((gray[i] and 0xff) ushr 4)).toByte()
                    i++
                }
            }
            if (((lastIndices != null) && indices.contentEquals(lastIndices))) {
                return
            }
            if ((frames.size >= MAX_FRAMES)) {
                overflowed = true
                return
            }
            frames.add(Frame(deflateData(indices), timestampMs))
            lastIndices = indices
        }
    }

    /** True if frames were dropped because the recording hit MAX_FRAMES. */
    fun isOverflowed(): Boolean {
        lock.withLock {
            return overflowed
        }
    }

    private fun writeGif(out: ByteSink): Unit {
        out.write('G')
        out.write('I')
        out.write('F')
        out.write('8')
        out.write('9')
        out.write('a')
        writeShortLE(out, width)
        writeShortLE(out, height)
        out.write(((0x80 or 0x70) or 0x03))
        out.write(0)
        out.write(0)
        run {
            var i: Int = 0
            while ((i < 16)) {
                var v: Int = (i * 17)
                out.write(v)
                out.write(v)
                out.write(v)
                i++
            }
        }
        out.write(0x21)
        out.write(0xff)
        out.write(11)
        out.write("NETSCAPE2.0".encodeToByteArray())
        out.write(3)
        out.write(1)
        writeShortLE(out, 0)
        out.write(0)
        run {
            var i: Int = 0
            while ((i < frames.size)) {
                val frame: Frame = frames.get(i)
                var delayCs: Int = LAST_FRAME_DELAY_CS
                if (((i + 1) < frames.size)) {
                    var deltaMs: Long = (frames.get((i + 1)).timestampMs - frame.timestampMs)
                    delayCs =
                        (maxOf(
                                MIN_FRAME_DELAY_CS.toLong(),
                                minOf(0xffffL, (deltaMs / 10.0).roundToLong()),
                            ))
                            .toInt()
                }
                out.write(0x21)
                out.write(0xf9)
                out.write(4)
                out.write(0x04)
                writeShortLE(out, delayCs)
                out.write(0)
                out.write(0)
                out.write(0x2c)
                writeShortLE(out, 0)
                writeShortLE(out, 0)
                writeShortLE(out, width)
                writeShortLE(out, height)
                out.write(0)
                writeLzwImageData(out, inflateData(frame.deflatedIndices, (width * height)))
                i++
            }
        }
        out.write(0x3b)
    }

    /**
     * Packs LZW codes LSB-first into bytes and the bytes into the 255-byte data sub-blocks GIF
     * image data is carried in.
     */
    private class SubBlockBitWriter {
        private val out: ByteSink

        private val block: ByteArray = ByteArray(255)

        private var blockLength: Int = 0

        private var bitBuffer: Int = 0

        private var bitCount: Int = 0

        constructor(out: ByteSink) {
            this.out = out
        }

        fun writeCode(code: Int, codeSize: Int): Unit {
            bitBuffer = (bitBuffer or (code shl bitCount))
            bitCount += codeSize
            while ((bitCount >= 8)) {
                writeByte((bitBuffer and 0xff))
                bitBuffer = (bitBuffer ushr 8)
                bitCount -= 8
            }
        }

        fun finish(): Unit {
            if ((bitCount > 0)) {
                writeByte((bitBuffer and 0xff))
                bitBuffer = 0
                bitCount = 0
            }
            flushBlock()
            out.write(0)
        }

        private fun writeByte(b: Int): Unit {
            block[blockLength++] = (b).toByte()
            if ((blockLength == 255)) {
                flushBlock()
            }
        }

        private fun flushBlock(): Unit {
            if ((blockLength == 0)) {
                return
            }
            out.write(blockLength)
            out.write(block, 0, blockLength)
            blockLength = 0
        }
    }
}
