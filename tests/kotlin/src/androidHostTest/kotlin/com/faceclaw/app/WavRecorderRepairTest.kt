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
}
