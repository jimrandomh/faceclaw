package com.faceclaw.app

import platform.Foundation.NSData

/** Binary adapters only: atlas identity, RLE, residency and planning stay in commonMain. */
class IosTextureAtlas {
    fun fontId(key: String): Int = GlyphAtlas.fontId(key)

    fun registerGlyphs(data: NSData) = GlyphAtlas.register(IosByteReader(data))

    fun registerAaGlyphs(data: NSData) = GlyphAtlas.registerAa(IosByteReader(data))

    fun registerFirmwareGlyphs(data: NSData) = FwGlyphAtlas.register(IosByteReader(data))

    fun imageId(key: String, width: Int, height: Int, data: NSData): Int =
        ImageAtlas.ensure(key, width, height, IosByteReader(data))
}

/** A snapshot keeps pixels and their screen-space draw identities together while JS coalesces. */
class IosTextureFrame internal constructor(internal val composite: SurfaceCompositor.Composite) {
    val pixels: NSData = composite.gray.data()
}

class IosTexturePlan internal constructor(result: TexturePlanner.Result, val usedBytes: Int) {
    val payload: NSData = result.payload.data()
    val resourceCommands: List<NSData> = result.resourceCommands.map { it.data() }
    val nextFid: Int = result.nextFid
}

/** One instance per BLE session, called on the session's serial JS thread. */
class IosTexturePlanner {
    private val cache = ResourceCacheState()

    fun reset() = cache.reset()

    fun plan(previous: NSData?, next: NSData, frame: IosTextureFrame, firstId: Int): IosTexturePlan? {
        val composite = frame.composite
        val result = TexturePlanner.plan(
            previous?.byteArray(), next.byteArray(), composite.width, composite.height,
            composite.draws, cache, firstId, true, ConnectionOptions.MULTI_RECT_MAX_RECTS,
        ) ?: return null
        return IosTexturePlan(result, cache.usedBytes())
    }
}
