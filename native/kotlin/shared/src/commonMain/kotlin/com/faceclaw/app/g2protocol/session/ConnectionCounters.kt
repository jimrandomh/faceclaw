package com.faceclaw.app

import kotlin.jvm.JvmStatic

/**
 * Process-wide counts of connection-reliability events: connect attempts,
 * transport failures by reason, ack timeouts, CFW replays, arm drops, how long
 * sessions lasted, and the like. The phone app's analytics drains them
 * (app/native/connection-counters.ts, app/analytics/). Only counts under fixed
 * event names are kept, never addresses or message contents. They pile up in
 * memory whether or not analytics is on; the app throws a drain away when it
 * is off.
 */
object ConnectionCounters {
    /** Distinct names kept between drains; new names past this are dropped. */
    private const val MAX_NAMES = 200

    private val lock = protocolPlatform().createLock()
    private var counts = LinkedHashMap<String, Long>()

    @JvmStatic
    fun increment(name: String) {
        lock.withLock {
            val current = counts[name]
            if (current != null) counts[name] = current + 1
            else if (counts.size < MAX_NAMES) counts[name] = 1
        }
    }

    /** The counts since the last drain, as a JSON object of name to count, and starts over. */
    @JvmStatic
    fun drain(): String {
        val drained = lock.withLock {
            val out = counts
            counts = LinkedHashMap()
            out
        }
        return Json.write(drained)
    }

    /** An event name from fixed text: "CFW recovery retry limit" -> "cfw-recovery-retry-limit". */
    @JvmStatic
    fun slug(text: String): String = text.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(60)
}
