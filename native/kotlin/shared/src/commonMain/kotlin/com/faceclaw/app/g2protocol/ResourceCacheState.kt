package com.faceclaw.app

import kotlin.jvm.JvmOverloads

/** Immutable content-addressed bytes; equality verifies bytes when hashes collide. */
class CachedResource @JvmOverloads constructor(bytes: ByteArray, val owner: String? = null) {
    val bytes: ByteArray = bytes.copyOf()
    val hash: Long = this.bytes.fold(-3750763034362895579L) { hash, byte ->
        (hash xor (byte.toLong() and 255)) * 1099511628211L
    }
    override fun hashCode(): Int = owner?.hashCode() ?: (hash xor (hash ushr 32)).toInt()
    override fun equals(other: Any?): Boolean = this === other ||
        other is CachedResource && owner == other.owner && hash == other.hash && bytes.contentEquals(other.bytes)
}

/**
 * Phone-side residency for the firmware's compacting resource arena. The owner serializes calls.
 * prepare() protects the current frame's hits before admitting misses, evicting only unprotected
 * LRU entries. Commands must be sent in returned order, before any dependent draws.
 */
class ResourceCacheState {
    companion object {
        /** Mirrors g2flash/patches/resource_cache.h. */
        const val CACHE_SIZE = 196608
        const val RESOURCE_COUNT = 512
        const val TABLE_BYTES = RESOURCE_COUNT * 4
        const val ARENA_BYTES = CACHE_SIZE - TABLE_BYTES
        const val MAX_RESOURCE_SIZE = 65536
        const val BLOCK_HEADER_BYTES = 16

        /** Mirrors g2flash/patches/zlib_glue.c. */
        const val UPLOAD_MODE = CFW_MSG_UPLOAD_RESOURCE
        const val EVICT_MODE = CFW_MSG_EVICT_RESOURCE
        fun allocationBytes(size: Int): Int = BLOCK_HEADER_BYTES + ((size + 3) and -4)
    }

    private data class Resident(val id: Int, val resource: CachedResource, var lastUsed: Long)
    private val residents = LinkedHashMap<CachedResource, Resident>()
    private val occupied = BooleanArray(RESOURCE_COUNT)
    var generation = 0
        private set
    private var pinned = emptySet<CachedResource>()
    fun pin(resources: Collection<CachedResource>) { pinned = resources.toSet() }
    private var allocated = 0
    private var clock = 0L
    private var resetRequired = true
    private val evictions = linkedSetOf<Int>()
    private val uploads = ArrayList<Resident>()

    /** Forget uncertain device state. The next upload first evicts every ID on both lenses. */
    fun reset() {
        generation++
        pinned = emptySet()
        residents.clear(); occupied.fill(false); allocated = 0; clock = 0
        evictions.clear(); uploads.clear(); resetRequired = true
    }

    fun usedBytes(): Int = TABLE_BYTES + allocated
    fun residentCount(): Int = residents.size
    fun resourceId(resource: CachedResource): Int = residents[resource]?.id ?: -1

    /** Called once per frame after coalescing. -1 entries stay baked into the pixel fallback. */
    fun prepare(resources: List<CachedResource>): IntArray {
        check(uploads.isEmpty() && evictions.isEmpty()) { "Previous resource commands have not been drained" }
        val protected = HashSet<Int>()
        for (resource in pinned) residents[resource]?.let { protected.add(it.id) }
        for (resource in resources) residents[resource]?.let { protected.add(it.id) }
        return IntArray(resources.size) { index ->
            val resource = resources[index]
            val hit = residents[resource]
            if (hit != null) {
                hit.lastUsed = ++clock
                hit.id
            } else if (resource.bytes.isEmpty() || resource.bytes.size > MAX_RESOURCE_SIZE) {
                -1
            } else {
                val needed = allocationBytes(resource.bytes.size)
                // Check feasibility before evicting anything for a request that cannot fit.
                val available = ARENA_BYTES - allocated + residents.values
                    .filter { it.id !in protected }.sumOf { allocationBytes(it.resource.bytes.size) }
                val canGetId = residents.size < RESOURCE_COUNT || residents.values.any { it.id !in protected }
                if (needed > available || !canGetId) -1
                else {
                    while (allocated + needed > ARENA_BYTES || residents.size >= RESOURCE_COUNT) {
                        val victim = residents.values.filter { it.id !in protected }.minBy { it.lastUsed }
                        residents.remove(victim.resource); occupied[victim.id] = false
                        allocated -= allocationBytes(victim.resource.bytes.size)
                        evictions.add(victim.id)
                    }
                    val id = occupied.indexOfFirst { !it }
                    val entry = Resident(id, resource, ++clock)
                    occupied[id] = true; allocated += needed
                    residents[resource] = entry; uploads.add(entry); protected.add(id)
                    id
                }
            }
        }
    }

    /** A rejected image plan must not commit unsent allocations or LRU changes. */
    fun checkpoint(): () -> Unit {
        val oldResidents = residents.mapValues { it.value.copy() }
        val oldOccupied = occupied.copyOf()
        val oldAllocated = allocated
        val oldClock = clock
        val oldReset = resetRequired
        val oldEvictions = evictions.toList()
        val oldUploads = uploads.toList()
        return {
            residents.clear(); residents.putAll(oldResidents); oldOccupied.copyInto(occupied)
            allocated = oldAllocated; clock = oldClock; resetRequired = oldReset
            evictions.clear(); evictions.addAll(oldEvictions)
            uploads.clear(); uploads.addAll(oldUploads)
        }
    }

    /** Batched evictions followed by bounded upload chunks, including exactly 64 KiB resources. */
    fun drainCommands(maxPayloadBytes: Int): MutableList<ByteArray> {
        require(maxPayloadBytes in 14..65535)
        val result = ArrayList<ByteArray>()
        val ids = if (resetRequired && uploads.isNotEmpty()) (0 until RESOURCE_COUNT).toList() else evictions.toList()
        for (batch in ids.chunked((maxPayloadBytes - 3) / 2)) {
            val out = ByteSink()
            out.write(EVICT_MODE); write16(out, batch.size)
            batch.forEach { write16(out, it) }
            result.add(out.toByteArray())
        }
        var entries = ArrayList<ByteArray>()
        var entryIds = HashSet<Int>()
        var size = 3
        fun flush() {
            if (entries.isEmpty()) return
            val out = ByteSink()
            out.write(UPLOAD_MODE); write16(out, entries.size)
            entries.forEach { out.write(it, 0, it.size) }
            result.add(out.toByteArray())
            entries = ArrayList(); entryIds = HashSet(); size = 3
        }
        for (entry in uploads) {
            val data = entry.resource.bytes
            if (entry.resource.owner != null) {
                flush()
                result.add(byteArrayOf(DrawProtocol.CREATE.toByte(), 1, 0) + DrawProtocol.word(entry.id) + data.copyOfRange(1, 5))
                continue
            }
            var offset = 0
            while (offset < data.size) {
                val count = minOf(data.size - offset, maxPayloadBytes - 13)
                val out = ByteSink()
                write16(out, entry.id); write32(out, data.size)
                write16(out, offset); write16(out, count)
                out.write(data, offset, count)
                val bytes = out.toByteArray()
                if (size + bytes.size > maxPayloadBytes || entry.id in entryIds) flush()
                entries.add(bytes); entryIds.add(entry.id); size += bytes.size
                offset += count
            }
        }
        flush()
        if (uploads.isNotEmpty()) resetRequired = false
        evictions.clear(); uploads.clear()
        return result
    }

    private fun write16(out: ByteSink, value: Int) { out.write(value and 255); out.write((value ushr 8) and 255) }
    private fun write32(out: ByteSink, value: Int) { write16(out, value); write16(out, value ushr 16) }
}
