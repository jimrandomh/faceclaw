package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/** Key/value persistence for the alarm schedule, journal and log (device-protected prefs on Android). */
interface AlarmStore {
    fun read(key: String): String?

    fun write(key: String, value: String?)
}

/** One scheduled item: the JS engine's item id, its wall-clock trigger time, and what to show. */
class AlarmEntry(
    @JvmField val id: Long,
    @JvmField val at: Long,
    title: String?,
    text: String?,
    kind: String?,
    @JvmField val snoozeMinutes: Int,
) {
    @JvmField val title: String = title ?: ""
    @JvmField val text: String = text ?: ""
    @JvmField val kind: String = kind ?: AlarmSchedule.KIND_ALARM

    fun toJson(): Map<String, Any?> =
        linkedMapOf(
            "id" to JsonNumber.of(id),
            "at" to JsonNumber.of(at),
            "title" to title,
            "text" to text,
            "kind" to kind,
            "snoozeMinutes" to JsonNumber.of(snoozeMinutes),
        )

    companion object {
        @JvmStatic
        fun fromJson(value: Any?): AlarmEntry? {
            val map = value.asObject() ?: return null
            return AlarmEntry(
                map["id"].asLong() ?: 0L,
                map["at"].asLong() ?: 0L,
                map["title"].asString() ?: "",
                map["text"].asString() ?: "",
                map["kind"].asString() ?: AlarmSchedule.KIND_ALARM,
                map["snoozeMinutes"].asInt() ?: 10,
            )
        }
    }
}

/**
 * The persisted alarm schedule, the phone-action journal and the diagnostics log, plus the
 * replay / staleness policies. Everything the platform's alarm clock API does not own.
 * Compound read-modify-write operations are serialized on one lock; the store itself only
 * needs to be atomic per key.
 */
class AlarmSchedule(
    private val store: AlarmStore,
    private val clock: () -> Long = ::currentTimeMillis,
    platform: ProtocolPlatform = protocolPlatform(),
) {
    private val lock = platform.createLock()

    /** All entries, in stored order. */
    fun entries(): List<AlarmEntry> = lock.withLock { readEntries() }

    fun find(id: Long): AlarmEntry? = lock.withLock { readEntries().firstOrNull { it.id == id } }

    /** Add or replace the entry with the same id (moved to the end). */
    fun put(entry: AlarmEntry) {
        lock.withLock {
            val next = readEntries().filter { it.id != entry.id } + entry
            writeEntries(next)
        }
    }

    fun remove(id: Long) {
        lock.withLock { writeEntries(readEntries().filter { it.id != id }) }
    }

    /**
     * Replay the schedule after a reboot, package update or clock change: entries already due
     * ring now if inside the grace window, older ones are dropped as missed (and logged), the
     * rest are handed to [arm]. Logs the outcome.
     */
    fun replay(reason: String?, ring: (AlarmEntry) -> Unit, arm: (AlarmEntry) -> Unit) {
        val scheduled = entries()
        val now = clock()
        var armed = 0
        for (entry in scheduled) {
            if (entry.at <= now) {
                if (now - entry.at <= LATE_GRACE_MS) {
                    ring(entry)
                } else {
                    log("missed " + entry.kind + " " + entry.id + " (" + reason + ")")
                    remove(entry.id)
                }
                continue
            }
            arm(entry)
            armed++
        }
        log("rescheduled $armed ($reason)")
    }

    /** The soonest future trigger time, or null when nothing is pending. */
    fun soonestPendingAt(now: Long = clock()): Long? =
        entries().filter { it.at > now }.minOfOrNull { it.at }

    /**
     * The schedule and the system alarm clock can disagree (a force-stop clears alarms but not
     * the file). True when the soonest stored entry is not what the system reports as its next
     * alarm clock; another app's sooner alarm is fine, only a later (or absent) one proves ours
     * is missing. [systemNextAlarmAt] is null when the system has no alarm clock set.
     */
    fun looksStale(systemNextAlarmAt: Long?, now: Long = clock()): Boolean {
        val soonest = soonestPendingAt(now) ?: return false
        return systemNextAlarmAt == null || systemNextAlarmAt > soonest + 1000
    }

    // ------------------------------------------------------------------
    // Phone-action journal (dismiss / snooze done on the phone, replayed by the JS engine)

    fun appendJournal(id: Long, action: String, minutes: Int) {
        val event = linkedMapOf<String, Any?>(
            "id" to JsonNumber.of(id),
            "action" to action,
            "minutes" to JsonNumber.of(minutes),
            "at" to JsonNumber.of(clock()),
        )
        lock.withLock {
            val journal = readArray(KEY_JOURNAL) + event
            store.write(KEY_JOURNAL, Json.write(journal))
        }
        log("phone " + action + " " + id + (if (minutes > 0) " ($minutes min)" else ""))
    }

    /** Hand the journal over as a JSON array and clear it. */
    fun drainJournal(): String =
        lock.withLock {
            val text = Json.write(readArray(KEY_JOURNAL))
            store.write(KEY_JOURNAL, "[]")
            text
        }

    // ------------------------------------------------------------------
    // Diagnostics log (bounded, newest last)

    fun log(line: String) {
        lock.withLock {
            val existing = readArray(KEY_LOG).map { it.asString() ?: it?.toString() ?: "" }
            val kept = existing.drop(maxOf(0, existing.size - (LOG_LINES - 1)))
            store.write(KEY_LOG, Json.write(kept + (clock().toString() + " " + line)))
        }
    }

    fun readLog(): String =
        lock.withLock { readArray(KEY_LOG).joinToString("\n") { it.asString() ?: it?.toString() ?: "" } }

    // ------------------------------------------------------------------

    private fun readArray(key: String): List<Any?> {
        val raw = store.read(key) ?: return emptyList()
        return runCatching { Json.parseArray(raw) }.getOrDefault(emptyList())
    }

    private fun readEntries(): List<AlarmEntry> = readArray(KEY_SCHEDULED).mapNotNull { AlarmEntry.fromJson(it) }

    private fun writeEntries(entries: List<AlarmEntry>) {
        store.write(KEY_SCHEDULED, Json.write(entries.map { it.toJson() }))
    }

    companion object {
        const val KIND_TIMER = "timer"
        const val KIND_ALARM = "alarm"

        const val KEY_SCHEDULED = "scheduled"
        const val KEY_JOURNAL = "journal"
        const val KEY_LOG = "log"
        const val LOG_LINES = 60

        /**
         * A schedule entry found already past due (after a reboot, or when the process was
         * asleep) rings if it is at most this late; older ones are dropped as missed. Matches
         * the JS engine's grace window.
         */
        const val LATE_GRACE_MS = 5 * 60_000L

        /** A stable per-item request code for platform alarm/notification identities. */
        @JvmStatic
        fun requestCode(id: Long): Int = (id xor (id ushr 32)).toInt() and 0x7fffffff
    }
}

/**
 * The last glasses status report pushed by the JS side. In memory only, so a dead process
 * reads as "no glasses"; a report older than [MAX_AGE_MS] is not trusted either.
 */
class GlassesStatusGate(private val clock: () -> Long = ::currentTimeMillis) {
    @Volatile private var connected = false
    @Volatile private var worn = false
    @Volatile private var charging = false
    @Volatile private var statusAtMs = 0L

    fun set(connected: Boolean, worn: Boolean, charging: Boolean) {
        this.connected = connected
        this.worn = worn
        this.charging = charging
        statusAtMs = clock()
    }

    /** True only when a fresh report says the glasses are connected, on a head, and not charging. */
    fun canCarryAlarm(): Boolean {
        val at = statusAtMs
        if (at == 0L || clock() - at > MAX_AGE_MS) return false
        return connected && worn && !charging
    }

    fun description(): String {
        val at = statusAtMs
        if (at == 0L) return "no glasses status"
        if (clock() - at > MAX_AGE_MS) return "glasses status stale"
        if (!connected) return "glasses not connected"
        if (charging) return "glasses charging"
        if (!worn) return "glasses not worn"
        return "glasses worn"
    }

    companion object {
        /** A glasses status report older than this is not trusted (the JS side is probably gone). */
        const val MAX_AGE_MS = 3 * 60_000L
    }
}
