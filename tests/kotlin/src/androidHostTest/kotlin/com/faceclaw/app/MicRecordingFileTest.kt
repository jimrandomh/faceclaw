package com.faceclaw.app

import java.io.File
import kotlin.math.PI
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MicRecordingFileTest {
    /**
     * A capture recorded through the real file adapters and read back. Set FACECLAW_MKA_SAMPLE
     * to a path to keep the file, for checking it against other Matroska tools (ffprobe, mpv).
     */
    @Test
    fun recordsACaptureToAFileThatReadsBack() {
        val kept = System.getenv("FACECLAW_MKA_SAMPLE")
        val file = if (kept.isNullOrEmpty()) File.createTempFile("capture", ".mka") else File(kept)
        try {
            val writer = MicRecordingWriter(openFileOutput(file.path), "{\"mics\":4,\"app\":\"test\"}", 1_700_000_000_000)
            val mixer = SingleTempleMixer()
            // Five seconds: each temple streams a stereo pair of tones on its own tick.
            for (index in 0 until 100) {
                for (side in 0..1) {
                    val pcm = ShortArray(1600) {
                        val frame = index * 800 + it / 2
                        val hz = if (side == 0) 440.0 else 660.0
                        (sin(2 * PI * hz * frame / 16000) * (if (it % 2 == 0) 8000 else 4000)).toInt().toShort()
                    }
                    val chunk = MicChunk(if (side == 0) MicStream.LEFT else MicStream.RIGHT, 2, 16000, pcm, 800, 10_000 + index * 50L + side * 7)
                    chunk.sequence = index
                    chunk.deviceTickMs = (if (side == 0) 500_000L else 123_456L) + index * 50L
                    chunk.hasDirection = true
                    chunk.angleDegrees = if (side == 0) -30 else 25
                    chunk.ssr = 12
                    writer.write(chunk)
                    mixer.mix(chunk)?.let { writer.write(it) }
                }
            }
            // The right temple's chunks arrive 7 ms behind the left's.
            assertEquals(5007L, writer.finish())

            val reader = MicRecordingReader(openFileInput(file.path))
            assertEquals(5007L, reader.durationMs)
            assertEquals("left temple 2ch + right temple 2ch", reader.description)
            assertEquals("{\"mics\":4,\"app\":\"test\"}", reader.configJson)
            var left = 0
            var right = 0
            while (true) {
                val chunk = reader.next() ?: break
                if (chunk.stream == MicStream.LEFT) left++ else right++
                assertEquals(12, chunk.ssr)
            }
            assertEquals(100, left)
            assertEquals(100, right)
            reader.close()
            // Audio (three tracks) plus the frame metadata.
            assertTrue(file.length() > 100 * 2 * 3200 + 100 * 1600)
        } finally {
            if (kept.isNullOrEmpty()) file.delete()
        }
    }
}
