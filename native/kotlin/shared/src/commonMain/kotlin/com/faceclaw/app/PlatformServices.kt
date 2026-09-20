package com.faceclaw.app

/** Platform selection happens at compilation; protocol algorithms stay shared. */
internal expect fun protocolPlatform(): ProtocolPlatform

internal expect fun deflateData(bytes: ByteArray): ByteArray

internal expect fun inflateData(bytes: ByteArray, size: Int): ByteArray

internal expect fun readFileData(path: String): ByteArray
