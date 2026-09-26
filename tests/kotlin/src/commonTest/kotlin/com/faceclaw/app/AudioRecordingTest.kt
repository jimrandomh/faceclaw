package com.faceclaw.app

import kotlin.test.*

internal expect fun digest(bytes: ByteArray): String

class AudioRecordingTest {
    @Test
    fun javaNoiseSuppressionGoldenAcrossChunksAndReset() {
        val suppressor = FaceclawNoiseSuppressor(16000)
        val output = ByteSink()
        for (round in 0 until 80) {
            val input = ByteArray(if (round % 7 == 0) 514 else 640)
            for (i in 0 until input.size / 2) {
                val value = ((round * 317 + i * 773) % 48000) - 24000
                input[i * 2] = value.toByte()
                input[i * 2 + 1] = (value shr 8).toByte()
            }
            if (round == 41) suppressor.reset()
            output.write(assertNotNull(suppressor.process(input)))
        }
        // SHA-256 from the original Java DSP, including warmup and irregular chunks.
        assertEquals(
            "4a7e86b70d61d683b17c7051dbd6666f5ea62427fdd7fdb1d4c9a1772a1eb8ef",
            digest(output.toByteArray()),
        )
    }

    @Test
    fun javaGifGoldenIncludingDedupAndLzwCodeGrowth() {
        val recorder = SharedGifScreenRecorder()
        assertTrue(recorder.encode().isEmpty())
        for (round in 0 until 7) {
            val pixels = ByteArray(33 * 17) { ((it * 73 + round * 117) % 256).toByte() }
            recorder.addFrame(pixels, 33, 17, round * 133L)
            recorder.addFrame(pixels, 33, 17, round * 133L + 10)
        }
        assertFalse(recorder.isOverflowed())
        assertEquals(
            "8c5dcb98fa03653972f7f7d5ddaaacff323dd633578905bc252ebe21f9d82780",
            digest(recorder.encode()),
        )
    }
}
