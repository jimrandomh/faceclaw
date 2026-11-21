package com.faceclaw.app

/**
 * A screen recording: what the glasses held when it started, then a log of every Bluetooth
 * message written to them, with the frame-timing annotations ([FrameTimingsCore]) and session
 * log lines from the same stretch of time. tools/screen-recording-visualizer replays the
 * messages to show what was on the display at each moment, next to the timings and a
 * breakdown of where the bytes went.
 *
 * The file is JSON Lines; tools/screen-recording-visualizer/FORMAT.md describes every record.
 * Times are [ProtocolPlatform.elapsedRealtimeMs]; the header carries the wall clock of its own
 * time.
 *
 * Capturing an event only stores references under a leaf lock, so it is cheap on the BLE
 * worker and the frame-timing callers; encoding happens in [writeLines], after the recording
 * has ended. Byte arrays handed in must not change afterwards.
 */
class ScreenRecorder(
    private val platform: ProtocolPlatform = protocolPlatform(),
    private val wallClockMs: () -> Long = { currentTimeMillis() },
    private val maxBytes: Long = MAX_BYTES,
    private val formatWallClock: (Long) -> String = { formatLocalTime(it, "yyyy-MM-dd HH:mm:ss.SSS") },
) : FrameTimingsSink {
    companion object {
        const val FORMAT = "faceclaw-screen-recording"
        const val VERSION = 1
        const val FILE_SUFFIX = ".fcrec.jsonl"

        /** Backstop against unbounded growth if a recording is left running. */
        const val MAX_BYTES = 96L * 1024 * 1024

        /** [DeviceState.lenses] / message `lenses` bits. */
        const val LENS_LEFT = 1
        const val LENS_RIGHT = 2
        const val LENS_BOTH = 3

        private const val BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

        private fun appendBase64(out: StringBuilder, bytes: ByteArray) {
            var i = 0
            while (i + 2 < bytes.size) {
                val n = ((bytes[i].toInt() and 255) shl 16) or ((bytes[i + 1].toInt() and 255) shl 8) or
                    (bytes[i + 2].toInt() and 255)
                out.append(BASE64[n ushr 18]).append(BASE64[(n ushr 12) and 63])
                    .append(BASE64[(n ushr 6) and 63]).append(BASE64[n and 63])
                i += 3
            }
            val left = bytes.size - i
            if (left > 0) {
                val n = ((bytes[i].toInt() and 255) shl 16) or (if (left == 2) (bytes[i + 1].toInt() and 255) shl 8 else 0)
                out.append(BASE64[n ushr 18]).append(BASE64[(n ushr 12) and 63])
                    .append(if (left == 2) BASE64[(n ushr 6) and 63] else '=').append('=')
            }
        }

        private fun appendValue(out: StringBuilder, value: Any?) {
            when (value) {
                null -> out.append("null")
                is String -> out.append(Json.quote(value))
                is Boolean -> out.append(if (value) "true" else "false")
                is Int -> out.append(value)
                is Long -> out.append(value)
                is ByteArray -> {
                    out.append('"')
                    appendBase64(out, value)
                    out.append('"')
                }
                is IntArray -> {
                    out.append('[')
                    for (i in value.indices) {
                        if (i > 0) out.append(',')
                        out.append(value[i])
                    }
                    out.append(']')
                }
                is List<*> -> {
                    out.append('[')
                    for (i in value.indices) {
                        if (i > 0) out.append(',')
                        appendValue(out, value[i])
                    }
                    out.append(']')
                }
                is Map<*, *> -> {
                    out.append('{')
                    var first = true
                    for ((key, entry) in value) {
                        if (!first) out.append(',')
                        first = false
                        out.append(Json.quote(key as String)).append(':')
                        appendValue(out, entry)
                    }
                    out.append('}')
                }
                else -> error("Unsupported recording value: ${value::class.simpleName}")
            }
        }

        /** Rough bytes [value] keeps alive, for the [maxBytes] backstop. */
        private fun cost(value: Any?): Long = when (value) {
            is String -> 16L + value.length
            is ByteArray -> 16L + value.size
            is IntArray -> 16L + value.size * 4L
            is List<*> -> 16L + value.sumOf { cost(it) }
            is Map<*, *> -> 16L + value.entries.sumOf { 16L + cost(it.value) }
            else -> 8L
        }
    }

    /**
     * What one lens (or both, when they hold the same) had when the recording started: the screen
     * buffer, the resource cache, and the root display list. [screen] is packed 4bpp rows, or null
     * when unknown. A writable surface's [Resource.data] is its current pixels.
     */
    class DeviceState(
        val lenses: Int,
        val width: Int,
        val height: Int,
        val screen: ByteArray?,
        val root: Int,
        val resources: List<Resource>,
    ) {
        class Resource(val id: Int, val data: ByteArray, val owner: String?)
    }

    /** One record: its type and time, then alternating field names and values (null values are left out). */
    private class Event(val type: String, val atMs: Long, val fields: Array<out Any?>)

    private val lock = platform.createLock()
    private val events = ArrayList<Event>()
    private var header: Event? = null
    private var bytes = 0L
    private var ended = false
    private var truncated = false

    /** Messages created up to this trace ID were planned before the recording: their effect is in the state dump. */
    private var baselineMessageId = 0
    private val loggedMessages = HashSet<Int>()
    private var lastScreen: ByteArray? = null
    private val stockGlyphs = HashSet<Int>()
    private val stockAdvances = HashSet<Long>()

    /** True if records were dropped because the recording hit its size backstop. */
    val isTruncated: Boolean
        get() = lock.withLock { truncated }

    private fun add(type: String, atMs: Long, vararg fields: Any?) {
        lock.withLock {
            if (ended || header == null) return
            if (truncated) return
            var size = 48L
            for (i in 1 until fields.size step 2) size += cost(fields[i])
            if (bytes + size > maxBytes) {
                truncated = true
                events.add(Event("mark", atMs, arrayOf<Any?>("text", "recording hit its size limit; later records were dropped")))
                return
            }
            bytes += size
            events.add(Event(type, atMs, fields))
        }
    }

    /**
     * Start the recording. [glasses] names what is on the other end ("g2", "rayneo-io", "g1", or
     * "none" for the phone-only preview) and [width] by [height] is its screen, 0 if not yet
     * known; [baselineMessageId] is [OutboundMessage.lastTraceId] at the moment the [states]
     * were read.
     */
    fun begin(glasses: String, width: Int, height: Int, baselineMessageId: Int = 0, states: List<DeviceState> = emptyList()) {
        val now = platform.elapsedRealtimeMs()
        val wall = wallClockMs()
        lock.withLock {
            if (header != null) return
            this.baselineMessageId = baselineMessageId
            header = Event("header", now, arrayOf<Any?>(
                "format", FORMAT,
                "version", VERSION,
                "wallClockMs", wall,
                "localTime", formatWallClock(wall),
                "glasses", glasses,
                "width", width,
                "height", height,
            ))
        }
        for (state in states) {
            add("state", now,
                "lenses", state.lenses,
                "width", state.width,
                "height", state.height,
                "root", state.root,
                "screen", state.screen,
                "resources", state.resources.map { resource ->
                    val entry = LinkedHashMap<String, Any?>()
                    entry["id"] = resource.id
                    if (resource.owner != null) entry["owner"] = resource.owner
                    entry["data"] = resource.data
                    entry
                })
        }
    }

    /** Close the recording; later events are ignored. */
    fun end() {
        val now = platform.elapsedRealtimeMs()
        lock.withLock {
            if (ended || header == null) return
            events.add(Event("end", now, arrayOf<Any?>("truncated", truncated)))
            ended = true
        }
    }

    // ---------------------------------------------------------------------
    // Bluetooth messages

    /**
     * [message] is about to be written as [packets]. The first write of a message carries its
     * payload; replays of it only name it.
     */
    fun messageWriting(atMs: Long, message: OutboundMessage, packets: List<ByteArray>) {
        val first = lock.withLock { loggedMessages.add(message.traceId) }
        val wire = IntArray(packets.size) { packets[it].size }
        if (!first) {
            add("msg", atMs, "id", message.traceId, "attempt", message.cfwRetries + 1, "magic", message.magic, "wire", wire)
            return
        }
        val custom = message.sid == CfwTransport.SID
        add("msg", atMs,
            "id", message.traceId,
            "attempt", message.cfwRetries + 1,
            "kind", message.kind,
            "label", message.label,
            "sid", message.sid,
            "magic", message.magic,
            "arm", if (message.isLeftArmMessage) "L" else "R",
            "lenses", if (custom) message.cfwRequiredLenses else null,
            "frame", if (message.frameId > 0) message.frameId else null,
            "update", if (message.imageUpdateId > 0) message.imageUpdateId else null,
            "part", if (message.imageUpdateId > 0) message.imageMessageNumber else null,
            "parts", if (message.imageUpdateId > 0) message.imageMessageCount else null,
            "baseline", if (message.traceId <= baselineMessageId) true else null,
            "wire", wire,
            "payload", message.message)
    }

    /**
     * Packets written outside the message queue (link control, relayed packets): traffic to
     * count, with nothing to replay.
     */
    fun rawWrite(atMs: Long, leftArm: Boolean, label: String, packets: List<ByteArray>) =
        add("write", atMs, "arm", if (leftArm) "L" else "R", "label", label, "wire", IntArray(packets.size) { packets[it].size })

    /** The write of [message] returned; [ok] false means the link refused or timed out. */
    fun messageWritten(atMs: Long, message: OutboundMessage, ok: Boolean) =
        add("sent", atMs, "id", message.traceId, "attempt", message.cfwRetries + 1, "ok", ok)

    /** One lens acknowledged (or, with [nack], rejected) a private-stream message. */
    fun lensAck(atMs: Long, message: OutboundMessage, lens: Int, nack: Boolean) =
        add("lens-ack", atMs, "id", message.traceId, "lens", lens, "nack", if (nack) true else null)

    /** [message] is complete: every lens it needed has acknowledged it. */
    fun messageAcked(atMs: Long, message: OutboundMessage) = add("ack", atMs, "id", message.traceId)

    /** [message] ran out its acknowledgement deadline. */
    fun messageTimedOut(atMs: Long, message: OutboundMessage) = add("timeout", atMs, "id", message.traceId)

    // ---------------------------------------------------------------------
    // Annotations

    /** A session log line. */
    fun log(atMs: Long, level: String, text: String) = add("log", atMs, "level", level, "text", text)

    override fun frameStarted(id: Int, parentId: Int, reason: String, atMs: Long, wallClockMs: Long) =
        add("frame", atMs, "id", id, "parent", if (parentId > 0) parentId else null, "reason", reason, "wallClockMs", wallClockMs)

    override fun frameAnnotated(id: Int, atMs: Long, text: String) = add("frame-note", atMs, "id", id, "text", text)

    override fun frameLine(id: Int, atMs: Long, thread: String, message: String) =
        add("frame-log", atMs, "id", id, "thread", thread, "text", message)

    override fun frameFinished(id: Int, atMs: Long, outcome: String) = add("frame-end", atMs, "id", id, "outcome", outcome)

    // ---------------------------------------------------------------------
    // Screens and fonts

    /**
     * The phone's own composite of the screen (8-bit gray), deflated; a repeat of the previous
     * one is dropped. Sessions whose messages can't be replayed rely on these for the picture;
     * the others carry one at each end, to check the replay against.
     */
    fun addScreen(source: String, gray: ByteArray?, width: Int, height: Int) {
        if (gray == null || width <= 0 || height <= 0 || gray.size < width * height) return
        val now = platform.elapsedRealtimeMs()
        val packed = BmpUtil.pack4bppFromGray8(gray, width, height)
        lock.withLock {
            if (ended || header == null) return
            val last = lastScreen
            if (last != null && last.contentEquals(packed)) return
            lastScreen = packed
        }
        add("screen", now, "source", source, "width", width, "height", height, "encoding", "deflate", "pixels", deflateData(packed))
    }

    fun addComposite(source: String, composite: SurfaceCompositor.Composite?) {
        if (composite != null) addScreen(source, composite.gray, composite.width, composite.height)
    }

    /**
     * The glasses draw stock-font text themselves, so a replay needs that font's glyphs. Record
     * the ones [draws] uses that are new to this recording, with the pen advance between each
     * pair of neighbours (which is where the firmware's kerning shows up).
     */
    fun observeStockText(draws: Array<SurfaceCompositor.ScreenDraw>?) {
        if (draws == null) return
        var glyphs: ArrayList<Any?>? = null
        var advances: ArrayList<Any?>? = null
        lock.withLock {
            if (ended || header == null) return
            for (draw in draws) {
                if (draw.kind != SurfaceCompositor.ScreenDraw.KIND_FWTEXT) continue
                val cps = draw.fwCps ?: continue
                val dx = draw.fwDx ?: continue
                for (i in cps.indices) {
                    val cp = cps[i]
                    if (cp !in stockGlyphs) {
                        val entry = FwGlyphAtlas.get(cp)
                        if (entry != null) {
                            stockGlyphs.add(cp)
                            val glyph = LinkedHashMap<String, Any?>()
                            glyph["cp"] = cp
                            glyph["x"] = entry.ofsX
                            glyph["y"] = entry.inkTop
                            glyph["width"] = entry.boxW
                            glyph["height"] = entry.boxH
                            glyph["pixels"] = entry.nibbles
                            (glyphs ?: ArrayList<Any?>().also { glyphs = it }).add(glyph)
                        }
                    }
                    if (i + 1 < cps.size && i + 1 < dx.size &&
                        stockAdvances.add((cp.toLong() shl 32) or (cps[i + 1].toLong() and 0xffffffffL))) {
                        (advances ?: ArrayList<Any?>().also { advances = it }).add(intArrayOf(cp, cps[i + 1], dx[i + 1] - dx[i]))
                    }
                }
            }
        }
        if (glyphs != null || advances != null) {
            add("stock-font", platform.elapsedRealtimeMs(), "glyphs", glyphs ?: emptyList<Any?>(), "advances", advances ?: emptyList<Any?>())
        }
    }

    // ---------------------------------------------------------------------
    // Output

    /** Each record as one line of JSON (no line terminator), header first. Empty before [begin]. */
    fun writeLines(consumer: (String) -> Unit) {
        val all = lock.withLock {
            val first = header ?: return
            listOf(first) + events
        }
        val out = StringBuilder(256)
        fun line(event: Event) {
            out.clear()
            out.append("{\"type\":").append(Json.quote(event.type)).append(",\"t\":").append(event.atMs)
            for (i in 0 until event.fields.size - 1 step 2) {
                val value = event.fields[i + 1] ?: continue
                out.append(',').append(Json.quote(event.fields[i] as String)).append(':')
                appendValue(out, value)
            }
            out.append('}')
            consumer(out.toString())
        }
        for (event in all) line(event)
    }

    /** The whole file as text; for tests and small recordings. */
    fun encodeToString(): String {
        val out = StringBuilder()
        writeLines { out.append(it).append('\n') }
        return out.toString()
    }
}
