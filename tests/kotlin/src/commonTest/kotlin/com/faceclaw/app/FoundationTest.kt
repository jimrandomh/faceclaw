package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FoundationTest {
    @Test
    fun jsonRoundTripsObjectsArraysAndNumbers() {
        val text = """{"a":1,"b":[true,null,"x\ny"],"c":{"d":2.5,"e":-3}}"""
        val value = Json.parseObject(text)
        assertEquals(1, value["a"].asInt())
        assertEquals(listOf(true, null, "x\ny"), value["b"].asArray())
        assertEquals(2.5, value["c"].asObject()!!["d"].asDouble())
        assertEquals(-3L, value["c"].asObject()!!["e"].asLong())
        assertEquals(text, Json.write(value))
        assertEquals("[1,2,\"q\\\"\"]", Json.write(listOf(1, 2L, "q\"")))
        assertEquals("1", JsonNumber.of(1.0).text)
        assertEquals("1.5", JsonNumber.of(1.5).text)
        assertNull("x".asInt())
    }

    @Test
    fun sha256MatchesKnownVector() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sha256Hex("abc".encodeToByteArray()))
        val incremental = Sha256Digest()
        incremental.update("a".encodeToByteArray())
        incremental.update("bc".encodeToByteArray())
        assertEquals(sha256("abc".encodeToByteArray()).toList(), incremental.digest().toList())
    }

    @Test
    fun latchAndQueueHandOffAcrossThreads() {
        val platform = testPlatform()
        val latch = Latch(1, platform)
        val queue = BlockingQueue<String>(platform)
        assertFalse(latch.await(20))
        startThread("foundation-test", true) {
            sleepMs(20)
            queue.put("hello")
            latch.countDown()
        }
        assertEquals("hello", queue.poll(2000))
        assertTrue(latch.await(2000))
        assertNull(queue.poll(10))
    }

    @Test
    fun interruptibleSleepConsumesEarlyInterrupt() {
        val platform = testPlatform()
        val sleep = InterruptibleSleep(platform)
        sleep.interrupt()
        val start = platform.elapsedRealtimeMs()
        assertFalse(sleep.sleep(500))
        assertTrue(platform.elapsedRealtimeMs() - start < 400)
        assertTrue(sleep.sleep(5))
        startThread("foundation-wake", true) { sleepMs(30); sleep.interrupt() }
        assertFalse(sleep.sleep(5000))
    }

    @Test
    fun wallClockFormatsPattern() {
        val text = formatLocalTime(0L, "yyyy")
        assertTrue(text == "1970" || text == "1969", text)
        assertTrue(currentTimeMillis() > 1_600_000_000_000L)
    }
}
