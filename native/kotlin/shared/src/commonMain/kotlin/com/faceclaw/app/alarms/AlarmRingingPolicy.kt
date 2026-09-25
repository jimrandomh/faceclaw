package com.faceclaw.app

import kotlin.jvm.JvmField

/** One item currently ringing. Subclassed by the Android service for its own bookkeeping. */
open class RingingItem(
    @JvmField val id: Long,
    title: String?,
    text: String?,
    kind: String?,
    snoozeMinutes: Int,
    @JvmField val ringAtMs: Long,
) {
    @JvmField val title: String = if (title == null || title.trim().isEmpty()) "Alarm" else title
    @JvmField val text: String = text ?: ""
    @JvmField val kind: String = kind ?: AlarmSchedule.KIND_ALARM
    @JvmField val snoozeMinutes: Int = maxOf(1, snoozeMinutes)
    @JvmField var deliveredAtMs: Long = 0
    @JvmField var escalated: Boolean = false
    @JvmField var silenced: Boolean = false
}

/** Delayed callbacks for the escalation timers; the owner's main thread on Android. */
interface AlarmScheduler {
    fun postDelayed(token: Any, delayMs: Long, action: () -> Unit)

    fun cancel(token: Any)

    fun cancelAll()
}

/** Platform effects of ringing: notifications, sound, the schedule, and the journal. */
interface RingingSink {
    /** Show or refresh the item's notification (title/status wording comes from the item). */
    fun showNotification(item: RingingItem)

    /** The item is gone: drop its notification and any per-item resources. */
    fun itemRemoved(item: RingingItem)

    /** Something started ringing: keep the device awake for the escalation window. */
    fun ringingStarted()

    fun startSound()

    fun stopSound()

    /** Re-arm the item (a snooze) at [atMs]. */
    fun reschedule(item: RingingItem, atMs: Long, minutes: Int)

    /** Forget the item's schedule entry (a dismiss). */
    fun cancelSchedule(id: Long)

    fun recordPhoneAction(id: Long, action: String, minutes: Int)

    fun log(line: String)
}

/**
 * Ringing escalation. Each item starts silent on the phone (a notification only, the glasses do
 * the ringing) and escalates to phone sound when the glasses cannot carry it: not connected,
 * not on a head, charging, no delivery confirmation from the JS side within [DELIVERY_WAIT_MS],
 * or no acknowledgement within [ACK_WAIT_MS] of delivery. Sound stops after [AUTO_SILENCE_MS]
 * while the notification stays. The policy is process-wide; the platform host (a service on
 * Android) attaches its scheduler and sink while it is alive.
 */
class AlarmRingingPolicy(
    private val gate: GlassesStatusGate,
    private val clock: () -> Long = ::currentTimeMillis,
    platform: ProtocolPlatform = protocolPlatform(),
) {
    private val lock = platform.createLock()
    /** Ringing items, oldest first. */
    private val ringing = LinkedHashMap<Long, RingingItem>()
    /**
     * Signals that arrived before the ring request was processed (the JS engine fires, launches
     * its window and reports delivery on the same thread the host queues behind), keyed by id
     * with their arrival time. Consumed by [ring].
     */
    private val deliveredEarly = LinkedHashMap<Long, Long>()
    private val stoppedEarly = LinkedHashMap<Long, Long>()
    private var scheduler: AlarmScheduler? = null
    private var sink: RingingSink? = null

    fun attach(scheduler: AlarmScheduler, sink: RingingSink) {
        lock.withLock {
            this.scheduler = scheduler
            this.sink = sink
        }
    }

    fun detach() {
        lock.withLock {
            scheduler?.cancelAll()
            scheduler = null
            sink = null
        }
    }

    fun isRinging(id: Long): Boolean = lock.withLock { ringing.containsKey(id) }

    fun isAnythingRinging(): Boolean = lock.withLock { ringing.isNotEmpty() }

    fun snapshot(): List<RingingItem> = lock.withLock { ArrayList(ringing.values) }

    /**
     * The glasses report showing [id]. True when the item is ringing (the host should process
     * the delivery); false when it is not yet known, in which case the signal is kept for a
     * ring request that follows within [EARLY_SIGNAL_MAX_AGE_MS].
     */
    fun deliveredOrDefer(id: Long): Boolean =
        lock.withLock {
            if (ringing.containsKey(id)) true
            else {
                deliveredEarly[id] = clock()
                false
            }
        }

    /** As [deliveredOrDefer], for an acknowledgement / cancellation. */
    fun stopOrDefer(id: Long): Boolean =
        lock.withLock {
            if (ringing.containsKey(id)) true
            else {
                stoppedEarly[id] = clock()
                false
            }
        }

    /** An item came due (idempotent per id: a duplicate ring only refreshes the notification). */
    fun ring(item: RingingItem) {
        if (item.id == 0L) return
        lock.withLock {
            val sink = sink ?: return
            val existing = ringing[item.id]
            if (existing != null) {
                // The engine's JS timeout and the platform alarm both fired: one ring.
                sink.showNotification(existing)
                return
            }
            if (takeEarlySignal(stoppedEarly, item.id)) {
                // Acknowledged or cancelled before this request was processed.
                sink.log("ring " + item.id + " already acknowledged")
                return
            }
            ringing[item.id] = item
            sink.log("ring " + item.kind + " " + item.id + " (" + gate.description() + ")")
            sink.ringingStarted()
            sink.showNotification(item)
            if (!gate.canCarryAlarm()) {
                escalate(item, gate.description())
                return
            }
            if (takeEarlySignal(deliveredEarly, item.id)) {
                markDelivered(item.id)
                return
            }
            // The glasses could carry it: give the JS side a moment to confirm they are
            // actually showing it, then hold for the acknowledgement.
            scheduler?.postDelayed("delivery:" + item.id, DELIVERY_WAIT_MS) {
                lock.withLock {
                    val current = ringing[item.id]
                    if (current != null && !current.escalated && current.deliveredAtMs == 0L) {
                        escalate(current, "not delivered to the glasses")
                    }
                }
            }
        }
    }

    fun markDelivered(id: Long) {
        lock.withLock {
            val item = ringing[id]
            if (item == null || item.deliveredAtMs != 0L) return
            item.deliveredAtMs = clock()
            sink?.log("delivered $id to glasses")
            scheduler?.postDelayed("ack:$id", ACK_WAIT_MS) {
                lock.withLock {
                    val current = ringing[id]
                    if (current != null && !current.escalated) {
                        escalate(current, "not acknowledged on the glasses")
                    }
                }
            }
        }
    }

    private fun escalate(item: RingingItem, reason: String) {
        if (item.escalated) return
        item.escalated = true
        val sink = sink ?: return
        sink.log("phone sound for " + item.id + ": " + reason)
        sink.showNotification(item)
        sink.startSound()
        scheduler?.postDelayed("silence:" + item.id, AUTO_SILENCE_MS) {
            lock.withLock {
                val current = ringing[item.id]
                if (current != null && current.escalated && !current.silenced) {
                    current.silenced = true
                    this.sink?.log("auto-silenced " + current.id)
                    this.sink?.showNotification(current)
                    syncSound()
                }
            }
        }
    }

    /** Dismissed on the phone: journal it, stop it, and drop the schedule entry. */
    fun dismiss(id: Long) {
        lock.withLock {
            val item = ringing[id] ?: return
            val sink = sink ?: return
            sink.recordPhoneAction(id, "dismiss", 0)
            removeItem(item)
            // A one-off is over; the engine re-arms repeats.
            sink.cancelSchedule(id)
        }
    }

    /** Snoozed on the phone: journal it, stop it, and re-arm on the phone directly so the snooze holds even with the JS side gone. */
    fun snooze(id: Long) {
        lock.withLock {
            val item = ringing[id] ?: return
            val sink = sink ?: return
            val minutes = item.snoozeMinutes
            sink.recordPhoneAction(id, "snooze", minutes)
            removeItem(item)
            sink.reschedule(item, clock() + minutes * 60_000L, minutes)
        }
    }

    /** Stop an item without a phone action (acknowledged on the glasses / cancelled by the engine). */
    fun stopQuietly(id: Long, reason: String) {
        lock.withLock {
            val item = ringing[id] ?: return
            sink?.log("$reason $id")
            removeItem(item)
        }
    }

    /** Start or stop the sound to match whether any escalated, not-yet-silenced item exists. */
    fun syncSound() {
        lock.withLock {
            val sink = sink ?: return
            if (ringing.values.any { it.escalated && !it.silenced }) sink.startSound() else sink.stopSound()
        }
    }

    fun cancelTimers() {
        lock.withLock { scheduler?.cancelAll() }
    }

    private fun removeItem(item: RingingItem) {
        ringing.remove(item.id)
        sink?.itemRemoved(item)
        syncSound()
    }

    /** Consume an early signal for the id; stale entries are dropped. */
    private fun takeEarlySignal(signals: MutableMap<Long, Long>, id: Long): Boolean {
        val at = signals.remove(id)
        val now = clock()
        signals.entries.removeAll { now - it.value > EARLY_SIGNAL_MAX_AGE_MS }
        return at != null && now - at <= EARLY_SIGNAL_MAX_AGE_MS
    }

    companion object {
        /** How long to wait for the JS side to confirm the glasses are showing the item. */
        const val DELIVERY_WAIT_MS = 5_000L
        /** How long after delivery to the glasses before the phone joins in. */
        const val ACK_WAIT_MS = 30_000L
        /** Sound and vibration stop after this; the notification stays. */
        const val AUTO_SILENCE_MS = 10 * 60_000L
        const val EARLY_SIGNAL_MAX_AGE_MS = 15_000L
    }
}
