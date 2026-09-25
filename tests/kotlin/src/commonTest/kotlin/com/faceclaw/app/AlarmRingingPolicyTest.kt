package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class FakeScheduler : AlarmScheduler {
    val pending = LinkedHashMap<Any, Pair<Long, () -> Unit>>()
    override fun postDelayed(token: Any, delayMs: Long, action: () -> Unit) { pending[token] = delayMs to action }
    override fun cancel(token: Any) { pending.remove(token) }
    override fun cancelAll() { pending.clear() }
    fun fire(token: Any) { val entry = pending.remove(token) ?: error("no timer $token"); entry.second() }
}

private class FakeSink : RingingSink {
    val events = ArrayList<String>()
    var sounding = false
    override fun showNotification(item: RingingItem) { events.add("notify ${item.id} " + (if (item.silenced) "silenced" else if (item.escalated) "ringing" else "glasses")) }
    override fun itemRemoved(item: RingingItem) { events.add("removed ${item.id}") }
    override fun ringingStarted() { events.add("wake") }
    override fun startSound() { if (!sounding) { sounding = true; events.add("sound on") } }
    override fun stopSound() { if (sounding) { sounding = false; events.add("sound off") } }
    override fun reschedule(item: RingingItem, atMs: Long, minutes: Int) { events.add("reschedule ${item.id} $atMs $minutes") }
    override fun cancelSchedule(id: Long) { events.add("cancel $id") }
    override fun recordPhoneAction(id: Long, action: String, minutes: Int) { events.add("action $id $action $minutes") }
    override fun log(line: String) { events.add("log $line") }
}

class AlarmRingingPolicyTest {
    private var now = 5_000_000L
    private val gate = GlassesStatusGate { now }
    private val scheduler = FakeScheduler()
    private val sink = FakeSink()
    private val policy = AlarmRingingPolicy(gate, { now }, testPlatform()).also { it.attach(scheduler, sink) }

    private fun item(id: Long, kind: String = AlarmSchedule.KIND_ALARM) = RingingItem(id, "Wake", "", kind, 9, now)

    @Test
    fun glassesUnavailableEscalatesImmediately() {
        policy.ring(item(1))
        assertEquals(listOf("log ring alarm 1 (no glasses status)", "wake", "notify 1 glasses", "log phone sound for 1: no glasses status", "notify 1 ringing", "sound on"), sink.events)
        assertTrue(policy.isRinging(1))
        assertEquals(setOf<Any>("silence:1"), scheduler.pending.keys)
        scheduler.fire("silence:1")
        assertEquals(listOf("log auto-silenced 1", "notify 1 silenced", "sound off"), sink.events.drop(6))
    }

    @Test
    fun deliveryAndAcknowledgementTimersEscalate() {
        gate.set(connected = true, worn = true, charging = false)
        policy.ring(item(2))
        assertEquals(listOf("log ring alarm 2 (glasses worn)", "wake", "notify 2 glasses"), sink.events)
        assertEquals(setOf<Any>("delivery:2"), scheduler.pending.keys)
        policy.markDelivered(2)
        assertEquals("log delivered 2 to glasses", sink.events.last())
        assertEquals(setOf<Any>("delivery:2", "ack:2"), scheduler.pending.keys)
        scheduler.fire("delivery:2") // delivered in time: no escalation
        assertFalse(policy.snapshot().single().escalated)
        scheduler.fire("ack:2")
        assertTrue(policy.snapshot().single().escalated)
        assertTrue(sink.sounding)
        // Acknowledged on the glasses afterwards: quiet stop, sound off.
        policy.stopQuietly(2, "acknowledged")
        assertEquals(listOf("log acknowledged 2", "removed 2", "sound off"), sink.events.takeLast(3))
        assertFalse(policy.isAnythingRinging())
    }

    @Test
    fun undeliveredRingEscalatesAfterDeliveryWait() {
        gate.set(connected = true, worn = true, charging = false)
        policy.ring(item(3))
        scheduler.fire("delivery:3")
        assertEquals("log phone sound for 3: not delivered to the glasses", sink.events[3])
        assertTrue(sink.sounding)
    }

    @Test
    fun snoozeAndDismissRecordActionsAndRearm() {
        policy.ring(item(4, AlarmSchedule.KIND_TIMER))
        policy.snooze(4)
        assertEquals(listOf("action 4 snooze 9", "removed 4", "sound off", "reschedule 4 ${now + 9 * 60_000L} 9"), sink.events.takeLast(4))
        policy.ring(item(5))
        policy.dismiss(5)
        assertEquals(listOf("action 5 dismiss 0", "removed 5", "sound off", "cancel 5"), sink.events.takeLast(4))
        policy.dismiss(99) // unknown: no-op
        assertEquals("cancel 5", sink.events.last())
    }

    @Test
    fun earlySignalsAreConsumedOrExpire() {
        gate.set(connected = true, worn = true, charging = false)
        assertFalse(policy.deliveredOrDefer(6))
        policy.ring(item(6))
        assertEquals("log delivered 6 to glasses", sink.events.last())
        assertEquals(setOf<Any>("ack:6"), scheduler.pending.keys)

        assertFalse(policy.stopOrDefer(7))
        policy.ring(item(7))
        assertEquals("log ring 7 already acknowledged", sink.events.last())
        assertFalse(policy.isRinging(7))

        assertFalse(policy.stopOrDefer(8))
        now += AlarmRingingPolicy.EARLY_SIGNAL_MAX_AGE_MS + 1
        policy.ring(item(8))
        assertTrue(policy.isRinging(8))
        assertTrue(policy.stopOrDefer(8))
        assertTrue(policy.deliveredOrDefer(8))
    }

    @Test
    fun duplicateRingOnlyRefreshesNotificationAndDetachDropsTimers() {
        policy.ring(item(9))
        val before = sink.events.size
        policy.ring(item(9))
        assertEquals(listOf("notify 9 ringing"), sink.events.drop(before))
        assertEquals(1, policy.snapshot().size)
        policy.detach()
        assertTrue(scheduler.pending.isEmpty())
        policy.ring(item(10)) // no host: ignored
        assertFalse(policy.isRinging(10))
    }
}
