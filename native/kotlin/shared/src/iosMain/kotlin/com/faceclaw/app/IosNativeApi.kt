@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import kotlinx.cinterop.*
import platform.Foundation.NSData
import platform.Foundation.create
import platform.posix.memcpy

/** NSData keeps large binary crossings out of per-element JavaScript bridge loops. */
internal fun NSData.byteArray(): ByteArray {
    require(length <= Int.MAX_VALUE.toULong())
    val result = ByteArray(length.toInt())
    if (result.isNotEmpty()) result.usePinned { memcpy(it.addressOf(0), bytes, length) }
    return result
}

internal fun ByteArray.data(): NSData =
    if (isEmpty()) NSData()
    else
        usePinned {
            NSData.create(bytes = it.addressOf(0), length = size.toULong())
        }

class IosByteReader(private val data: NSData) : ByteReader() {
    private var position = 0

    override fun remaining(): Int = data.length.toInt() - position

    override fun get(): Byte = get(position++)

    override fun get(index: Int): Byte {
        require(index >= 0 && index < data.length.toInt())
        return data.bytes!!.reinterpret<ByteVar>()[index]
    }

    override fun get(bytes: ByteArray, offset: Int, length: Int): ByteReader {
        require(
            offset >= 0 && length >= 0 && offset <= bytes.size - length && remaining() >= length
        )
        if (length > 0)
            bytes.usePinned {
                memcpy(
                    it.addressOf(offset),
                    data.bytes!!.reinterpret<ByteVar>() + position,
                    length.toULong(),
                )
            }
        position += length
        return this
    }
}

class IosCfwTransport {
    private val transport = CfwTransport(IosProtocolPlatform)

    fun reset() = transport.reset()

    fun close() = transport.close()

    fun encode(data: NSData, streamId: Int, lenses: Int, maxWrite: Int): List<NSData> =
        transport.encode(data.byteArray(), streamId, lenses, maxWrite + 3).map { it.data() }
}

class IosProtocolMessage(message: MessageReceiver.Message) {
    val sid = message.sid
    val flag = message.flag
    val payload = message.payload.data()
    val command = message.command
    val magic = message.magic
    val packet = message.packet?.data()
}

class IosMessageReceiver {
    private val receiver = MessageReceiver()

    fun clear() = receiver.clear()

    fun receive(link: String, data: NSData, now: Long): List<IosProtocolMessage> =
        receiver.receive(link, data.byteArray(), now).map { IosProtocolMessage(it) }
}

/** Stable binary facade over the shared wire algorithms and font parser. */
class IosProtocol {
    fun authentication(magic: Int): NSData = BleProtocol.buildAuthenticationRequest(magic).data()

    fun prelude(): NSData = BleProtocol.PRELUDE_F5872_PAYLOAD.data()

    fun heartbeat(magic: Int): NSData = BleProtocol.buildHeartbeat(magic).data()

    fun audioControl(magic: Int, enabled: Boolean): NSData =
        BleProtocol.buildAudioControl(magic, enabled).data()

    fun settingsQuery(magic: Int): NSData = BleProtocol.buildSettingsQuery(magic).data()

    fun shutdown(magic: Int): NSData = BleProtocol.buildShutdown(magic, 1).data()

    fun framebufferLease(acquire: Boolean): NSData =
        BleProtocol.buildFaceclawWakeControl(
                if (acquire) BleProtocol.FACECLAW_FB_OP_ACQUIRE
                else BleProtocol.FACECLAW_FB_OP_RELEASE,
                0,
            )
            .data()

    fun createLayout(magic: Int): NSData = BleProtocol.buildCreateInputPage(magic).data()

    fun integer(field: Int, value: Int): NSData = BleProtocol.encodeVarintField(field, value).data()

    fun bytes(field: Int, data: NSData): NSData =
        BleProtocol.encodeBytesField(field, data.byteArray()).data()

    fun crc(data: NSData): Int = CfwTransport.crc(data.byteArray())

    fun frame(data: NSData, sid: Int, flag: Int, sequence: Int, maxWrite: Int): List<NSData> =
        BleProtocol.framePb(data.byteArray(), sid, flag, sequence, maxWrite).map { it.data() }

    fun acks(data: NSData): List<CfwTransport.Ack>? =
        CfwTransport.parseAcks(data.byteArray())?.toList()

    fun readInteger(data: NSData, field: Int, fallback: Int): Int =
        BleProtocol.readVarintFieldValue(data.byteArray(), field, fallback)

    fun readBytes(data: NSData, field: Int): NSData? =
        BleProtocol.readFieldBytes(data.byteArray(), field)?.data()

    fun readString(data: NSData, field: Int): String =
        BleProtocol.readStringFieldValue(data.byteArray(), field)

    fun glassesInput(data: NSData, sid: Int, flag: Int): G2Event? =
        if (sid == BleProtocol.SID_EVENHUB && flag in intArrayOf(1, 6))
            G2Event.decodePayload(sid, data.byteArray())
        else null

    fun ringInput(data: NSData): G2Event? = FaceclawRingEventDecoder.decode(data.byteArray())?.event

    fun pack(data: NSData, width: Int, height: Int): NSData {
        require(width > 0 && height > 0 && data.length == width.toULong() * height.toULong())
        return BmpUtil.pack4bppFromGray8(data.byteArray(), width, height).data()
    }

    fun rle(data: NSData): NSData = BleImageOptimizer.rleEncode(data.byteArray()).data()

    fun boundingBox(
        previous: NSData?,
        next: NSData,
        width: Int,
        height: Int,
        frameId: Int,
    ): NSData? =
        BleImageOptimizer.buildIncrementalImagePayload(
                previous?.byteArray(),
                next.byteArray(),
                width,
                height,
                frameId,
            )
            ?.payload
            ?.data()

    fun fullFrameBands(data: NSData, width: Int, height: Int, firstId: Int): List<NSData> {
        require(
            width in 1..640 &&
                width % 4 == 0 &&
                height in 1..480 &&
                height % 2 == 0 &&
                data.length == (width * height / 2).toULong()
        )
        val packed = data.byteArray()
        var id = firstId
        return (0 until height step 64).map { top ->
            val result =
                BleImageOptimizer.encodeMode3Rect(
                        packed,
                        width / 2,
                        0,
                        top,
                        width,
                        minOf(64, height - top),
                        id,
                    )
                    .data()
            id = if (id >= 0xfffe) 1 else id + 1
            result
        }
    }

    fun fontMetrics(path: String): NSData = LvglFontFile.getMetrics(path).data()

    fun fontGlyph(path: String, codePoint: Int): NSData =
        LvglFontFile.getGlyph(path, codePoint).data()

    fun png(data: NSData, width: Int, height: Int): NSData =
        SharedScreenshots.encode4BitGrayPng(data.byteArray(), width, height).data()
}

/** iOS retains/coalesces surface updates in the same compositor Android uses. */
class IosSurfaceCompositor(width: Int, height: Int) {
    private val compositor = SurfaceCompositor().also { it.configureScreen(width, height) }
    private val sizes = mutableMapOf<String, Pair<Int, Int>>()
    private var sequence = 0L

    fun configure(
        id: String,
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        zOrder: Int,
        transparent: Boolean,
    ) {
        compositor.configureSurface(id, x, y, width, height, zOrder, if (transparent) 1 else 0)
        sizes[id] = width to height
    }

    fun remove(id: String) {
        sizes.remove(id)
        compositor.removeSurface(id)
    }

    fun visible(id: String, visible: Boolean) = compositor.setSurfaceVisible(id, visible)

    fun dim(below: Int, factor: Double) {
        require(factor.isFinite())
        compositor.setUnderlayDim(below, (factor.coerceIn(0.0, 1.0) * 256).toInt())
    }

    fun blank(blanked: Boolean) = compositor.setBlanked(blanked)

    fun submit(id: String, data: NSData, x: Int, y: Int, width: Int, height: Int) {
        val (sw, sh) = sizes[id] ?: error("Unknown surface: $id")
        require(width > 0 && height > 0 && data.length == width.toULong() * height.toULong())
        val left = maxOf(0, x)
        val right = minOf(sw, x + width)
        val top = maxOf(0, y)
        val bottom = minOf(sh, y + height)
        if (right <= left || bottom <= top) return
        val reader =
            if (left == x && top == y && right - left == width && bottom - top == height)
                IosByteReader(data)
            else {
                val source = data.byteArray()
                val clipped = ByteArray((right - left) * (bottom - top))
                for (row in top until bottom) source.copyInto(
                    clipped,
                    (row - top) * (right - left),
                    (row - y) * width + left - x,
                    (row - y) * width + right - x,
                )
                ArrayByteReader(clipped)
            }
        compositor.submitSurface(
            id,
            reader,
            left,
            top,
            right - left,
            bottom - top,
            (++sequence).toString(),
        )
    }

    fun composite(): NSData = compositor.composite().gray.data()
}
