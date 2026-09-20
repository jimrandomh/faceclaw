package com.faceclaw.app

import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest

/** Android's bulk ByteBuffer boundary avoids per-byte NativeScript crossings. */
object FaceclawFirmwareUtil {
    @JvmStatic fun bytesToHex(bytes: ByteArray?): String = BinaryEncoding.bytesToHex(bytes)

    @JvmStatic
    fun sha256Hex(data: ByteBuffer): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(data.duplicate())
        return bytesToHex(digest.digest())
    }

    @JvmStatic
    fun writeFile(path: String, data: ByteBuffer) {
        try {
            FileOutputStream(path).use { file ->
                file.channel.use { channel ->
                    val view = data.duplicate()
                    while (view.hasRemaining()) channel.write(view)
                }
            }
        } catch (e: java.io.IOException) {
            throw RuntimeException("firmware write failed: ${e.message}", e)
        }
    }
}
