package com.faceclaw.app

import kotlinx.cinterop.*

internal actual fun protocolPlatform(): ProtocolPlatform = IosProtocolPlatform

@OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)
internal actual fun readFileData(path: String): ByteArray {
    val file = platform.posix.fopen(path, "rb") ?: error("Cannot read $path")
    try {
        check(platform.posix.fseek(file, 0, platform.posix.SEEK_END) == 0)
        val size = platform.posix.ftell(file)
        require(size in 0..Int.MAX_VALUE.toLong())
        platform.posix.rewind(file)
        val bytes = ByteArray(size.toInt())
        if (bytes.isNotEmpty())
            bytes.usePinned {
                check(
                    platform.posix.fread(it.addressOf(0), 1u, bytes.size.toULong(), file) ==
                        bytes.size.toULong()
                )
            }
        return bytes
    } finally {
        platform.posix.fclose(file)
    }
}

@OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)
internal actual fun deflateData(bytes: ByteArray): ByteArray =
    kotlinx.cinterop.memScoped {
        val capacity = platform.zlib.compressBound(bytes.size.toULong())
        val result = ByteArray(capacity.toInt())
        val length = alloc<ULongVar>()
        length.value = capacity
        bytes.usePinned { input ->
            result.usePinned { output ->
                check(
                    platform.zlib.compress2(
                        output.addressOf(0).reinterpret(),
                        length.ptr,
                        if (bytes.isEmpty()) null else input.addressOf(0).reinterpret(),
                        bytes.size.toULong(),
                        platform.zlib.Z_DEFAULT_COMPRESSION,
                    ) == platform.zlib.Z_OK
                )
            }
        }
        result.copyOf(length.value.toInt())
    }

@OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)
internal actual fun inflateData(bytes: ByteArray, size: Int): ByteArray =
    kotlinx.cinterop.memScoped {
        val result = ByteArray(size)
        val length = alloc<ULongVar>()
        length.value = size.toULong()
        bytes.usePinned { input ->
            result.usePinned { output ->
                check(
                    platform.zlib.uncompress(
                        output.addressOf(0).reinterpret(),
                        length.ptr,
                        input.addressOf(0).reinterpret(),
                        bytes.size.toULong(),
                    ) == platform.zlib.Z_OK
                )
            }
        }
        check(length.value.toInt() == size) { "recorded frame truncated" }
        result
    }
