package com.faceclaw.app

internal actual fun protocolPlatform(): ProtocolPlatform = AndroidProtocolPlatform

internal actual fun readFileData(path: String): ByteArray {
    val file = java.io.File(path)
    require(file.isFile && file.canRead() && file.length() <= Int.MAX_VALUE)
    return file.readBytes()
}

internal actual fun deflateData(bytes: ByteArray): ByteArray {
    val encoder = java.util.zip.Deflater()
    try {
        encoder.setInput(bytes)
        encoder.finish()
        val out = ByteSink()
        val buffer = ByteArray(8192)
        while (!encoder.finished()) out.write(buffer, 0, encoder.deflate(buffer))
        return out.toByteArray()
    } finally {
        encoder.end()
    }
}

internal actual fun inflateData(bytes: ByteArray, size: Int): ByteArray {
    val decoder = java.util.zip.Inflater()
    try {
        decoder.setInput(bytes)
        val result = ByteArray(size)
        var offset = 0
        while (offset < size && !decoder.finished()) {
            val count = decoder.inflate(result, offset, size - offset)
            if (count == 0) break
            offset += count
        }
        check(offset == size) { "recorded frame truncated: $offset of $size" }
        return result
    } finally {
        decoder.end()
    }
}
