package com.faceclaw.app

import platform.Foundation.NSData

/**
 * Records the iOS voice bridge's audio to a Matroska audio file (.mka), the format Android's
 * captures are recorded in (see [MicRecordingWriter]). The bridge has one stream to record:
 * 16 kHz mono PCM16, as its recognizer hands it to TypeScript.
 */
class IosMicRecorder internal constructor(private val writer: MicRecordingWriter) {
    /** The recording stopped early: the file could not be written. */
    val failed: Boolean get() = writer.failed

    /** Appends a chunk of 16 kHz mono PCM16 (little-endian), as having arrived now. */
    fun append(pcm16le: NSData) {
        val bytes = pcm16le.byteArray()
        val samples = ShortArray(bytes.size / 2) { AudioSegmentation.pcm16le(bytes[it * 2], bytes[it * 2 + 1]) }
        writer.write(MicChunk(MicStream.MONO, 1, 16000, samples, samples.size, IosProtocolPlatform.elapsedRealtimeMs()))
    }

    /** Completes the file. Returns the recording's length in ms. */
    fun finish(): Long = writer.finish()
}

object IosMicRecordings {
    /**
     * A recorder writing a new file at [path], or null when the file cannot be created.
     * [configJson] describes the capture and is stored in the file.
     */
    fun open(path: String, configJson: String?): IosMicRecorder? =
        try {
            IosMicRecorder(MicRecordingWriter(openFileOutput(path), configJson, currentTimeMillis(), IosProtocolPlatform))
        } catch (error: Throwable) {
            PlatformLog.w("FaceclawMicRecording", "could not create $path: ${error.message}")
            null
        }
}
