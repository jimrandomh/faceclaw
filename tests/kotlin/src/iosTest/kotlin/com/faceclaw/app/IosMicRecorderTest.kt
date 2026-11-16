package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSUUID

class IosMicRecorderTest {
    @Test
    fun recordsPcmToAMatroskaFileThroughThePosixFileAdapters() {
        val path = NSTemporaryDirectory() + NSUUID().UUIDString + ".mka"
        try {
            val recorder = assertNotNull(IosMicRecordings.open(path, "{\"platform\":\"ios\"}"))
            // 2.5 s in 50 ms chunks: enough for whole clusters to reach the file before finish().
            for (index in 0 until 50) {
                val samples = ShortArray(800) { (index * 10 + it % 7).toShort() }
                recorder.append(AudioSegmentation.pcm16ToLittleEndian(samples, 0, samples.size).data())
            }
            assertFalse(recorder.failed)
            val length = recorder.finish()
            assertTrue(length >= 2500, "recorded $length ms")
            assertEquals(fileLength(path), openFileInput(path).length)

            val reader = MicRecordingReader(openFileInput(path))
            assertEquals("{\"platform\":\"ios\"}", reader.configJson)
            assertEquals("mic", reader.description)
            var chunks = 0
            var last: MicChunk? = null
            while (true) {
                last = reader.next() ?: break
                assertEquals(800, last.frames)
                assertEquals((chunks * 10).toShort(), last.pcm[0])
                chunks++
            }
            assertEquals(50, chunks)
            reader.close()
        } finally {
            deleteFile(path)
        }
        assertNull(IosMicRecordings.open("/nonexistent-directory/x.mka", null))
    }
}
