package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class MemoryStore : AlarmStore {
    val values = HashMap<String, String?>()
    override fun read(key: String): String? = values[key]
    override fun write(key: String, value: String?) { values[key] = value }
}

class AlarmScheduleTest {
    private val store = MemoryStore()
    private var now = 1_700_000_000_000L
    private val schedule = AlarmSchedule(store, { now }, testPlatform())

    @Test
    fun persistsEntriesAsJsonAndReplacesById() {
        schedule.put(AlarmEntry(7, now + 60_000, "Tea", "steep", AlarmSchedule.KIND_TIMER, 5))
        schedule.put(AlarmEntry(8, now + 120_000, null, null, null, 10))
        assertEquals("""[{"id":7,"at":${now + 60_000},"title":"Tea","text":"steep","kind":"timer","snoozeMinutes":5},{"id":8,"at":${now + 120_000},"title":"","text":"","kind":"alarm","snoozeMinutes":10}]""", store.values[AlarmSchedule.KEY_SCHEDULED])
        schedule.put(AlarmEntry(7, now + 90_000, "Tea", "steep", AlarmSchedule.KIND_TIMER, 5))
        assertEquals(listOf(8L, 7L), schedule.entries().map { it.id })
        assertEquals(now + 90_000, schedule.find(7)?.at)
        schedule.remove(8)
        assertNull(schedule.find(8))
        // A corrupt file reads as empty rather than failing.
        store.values[AlarmSchedule.KEY_SCHEDULED] = "{nope"
        assertTrue(schedule.entries().isEmpty())
    }

    @Test
    fun replayRingsRecentDropsMissedArmsFuture() {
        schedule.put(AlarmEntry(1, now - 60_000, "recent", "", null, 10))
        schedule.put(AlarmEntry(2, now - AlarmSchedule.LATE_GRACE_MS - 1, "old", "", AlarmSchedule.KIND_TIMER, 10))
        schedule.put(AlarmEntry(3, now + 60_000, "future", "", null, 10))
        val rang = ArrayList<Long>()
        val armed = ArrayList<Long>()
        schedule.replay("boot", { rang.add(it.id) }, { armed.add(it.id) })
        assertEquals(listOf(1L), rang)
        assertEquals(listOf(3L), armed)
        assertEquals(listOf(1L, 3L), schedule.entries().map { it.id })
        val log = schedule.readLog()
        assertTrue(log.contains("$now missed timer 2 (boot)"), log)
        assertTrue(log.endsWith("$now rescheduled 1 (boot)"), log)
    }

    @Test
    fun stalenessComparesSoonestPendingWithSystemAlarm() {
        assertFalse(schedule.looksStale(null))
        schedule.put(AlarmEntry(1, now - 1, "past", "", null, 10))
        assertNull(schedule.soonestPendingAt())
        schedule.put(AlarmEntry(2, now + 50_000, "", "", null, 10))
        schedule.put(AlarmEntry(3, now + 20_000, "", "", null, 10))
        assertEquals(now + 20_000, schedule.soonestPendingAt())
        assertTrue(schedule.looksStale(null))
        assertTrue(schedule.looksStale(now + 30_000))
        assertFalse(schedule.looksStale(now + 20_500))
        assertFalse(schedule.looksStale(now + 5_000))
    }

    @Test
    fun journalAppendsAndDrains() {
        schedule.appendJournal(5, "snooze", 10)
        now += 1000
        schedule.appendJournal(6, "dismiss", 0)
        assertEquals("""[{"id":5,"action":"snooze","minutes":10,"at":${now - 1000}},{"id":6,"action":"dismiss","minutes":0,"at":$now}]""", schedule.drainJournal())
        assertEquals("[]", schedule.drainJournal())
        val log = schedule.readLog().lines()
        assertEquals("${now - 1000} phone snooze 5 (10 min)", log[0])
        assertEquals("$now phone dismiss 6", log[1])
    }

    @Test
    fun logKeepsOnlyTheLastLines() {
        for (index in 0 until AlarmSchedule.LOG_LINES + 5) schedule.log("line $index")
        val lines = schedule.readLog().lines()
        assertEquals(AlarmSchedule.LOG_LINES, lines.size)
        assertEquals("$now line 5", lines.first())
        assertEquals("$now line ${AlarmSchedule.LOG_LINES + 4}", lines.last())
    }

    @Test
    fun glassesGateRequiresFreshWornConnectedNotCharging() {
        var clock = 10_000L
        val gate = GlassesStatusGate { clock }
        assertFalse(gate.canCarryAlarm())
        assertEquals("no glasses status", gate.description())
        gate.set(connected = true, worn = true, charging = false)
        assertTrue(gate.canCarryAlarm())
        assertEquals("glasses worn", gate.description())
        gate.set(connected = true, worn = false, charging = false)
        assertEquals("glasses not worn", gate.description())
        gate.set(connected = true, worn = true, charging = true)
        assertEquals("glasses charging", gate.description())
        gate.set(connected = false, worn = true, charging = false)
        assertEquals("glasses not connected", gate.description())
        gate.set(connected = true, worn = true, charging = false)
        clock += GlassesStatusGate.MAX_AGE_MS + 1
        assertFalse(gate.canCarryAlarm())
        assertEquals("glasses status stale", gate.description())
        assertEquals(0x7fffffff and (0x1_0000_0002L xor 1L).toInt(), AlarmSchedule.requestCode(0x1_0000_0002L))
        assertNotNull(AlarmEntry.fromJson(Json.parse("""{"id":1,"at":2}""")))
    }
}
