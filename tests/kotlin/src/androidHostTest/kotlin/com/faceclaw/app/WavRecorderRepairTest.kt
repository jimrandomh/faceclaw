package com.faceclaw.app

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals

class WavRecorderRepairTest {
    @Test
    fun repairsTheHeaderOfARecordingThatWasNeverFinished() {
        val file = File.createTempFile("unfinished", ".wav")
        try {
            // What a process death mid-recording leaves: the empty header from the start, the PCM
            // written since, and a torn half-sample at the end.
            file.writeBytes(BinaryEncoding.wavHeader(0, 16000, 1) + ByteArray(3201) { 1 })
            assertEquals(3200L, FaceclawWavRecorder.repairHeader(file.path, 16000, 1))
            val bytes = file.readBytes()
            assertEquals(44 + 3200, bytes.size)
            assertEquals(BinaryEncoding.wavHeader(3200, 16000, 1).toList(), bytes.copyOf(44).toList())
            assertEquals(-1L, FaceclawWavRecorder.repairHeader(file.path + ".missing", 16000, 1))
        } finally {
            file.delete()
        }
    }

    @Test
    fun keepsTheHeaderCurrentWhileRecording() {
        val file = File.createTempFile("recording", ".wav")
        try {
            val recorder = FaceclawWavRecorder(file.path, 16000, 1)
            // Under a second of audio: still the empty header from the start.
            recorder.append(ByteArray(16000))
            assertEquals(BinaryEncoding.wavHeader(0, 16000, 1).toList(), file.readBytes().copyOf(44).toList())
            // Past a second the header covers what is on disk, without waiting for finish(), and
            // later audio still lands at the end.
            recorder.append(ByteArray(16000) { 1 })
            recorder.append(ByteArray(100) { 2 })
            var bytes = file.readBytes()
            assertEquals(44 + 32100, bytes.size)
            assertEquals(BinaryEncoding.wavHeader(32000, 16000, 1).toList(), bytes.copyOf(44).toList())
            assertEquals(0.toByte(), bytes[44])
            assertEquals(1.toByte(), bytes[44 + 16000])
            assertEquals(2.toByte(), bytes.last())
            assertEquals(32100L, recorder.finish())
            bytes = file.readBytes()
            assertEquals(44 + 32100, bytes.size)
            assertEquals(BinaryEncoding.wavHeader(32100, 16000, 1).toList(), bytes.copyOf(44).toList())
        } finally {
            file.delete()
        }
    }
}
