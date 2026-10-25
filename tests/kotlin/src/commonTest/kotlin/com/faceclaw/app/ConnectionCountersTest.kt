package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals

class ConnectionCountersTest {
    @Test
    fun drainReturnsTheCountsSinceTheLastDrain() {
        ConnectionCounters.drain()
        ConnectionCounters.increment("g2.connect-attempt")
        ConnectionCounters.increment("g2.connect-attempt")
        ConnectionCounters.increment("g2.session-ready")
        assertEquals("""{"g2.connect-attempt":2,"g2.session-ready":1}""", ConnectionCounters.drain())
        assertEquals("{}", ConnectionCounters.drain())
    }

    @Test
    fun keepsCountingKnownNamesPastTheNameCap() {
        ConnectionCounters.drain()
        for (index in 0 until 250) ConnectionCounters.increment("name-$index")
        ConnectionCounters.increment("name-0")
        val drained = Json.parseObject(ConnectionCounters.drain())
        assertEquals(200, drained.size)
        assertEquals(JsonNumber("2"), drained["name-0"])
    }

    @Test
    fun slugsFailureReasons() {
        assertEquals("cfw-recovery-retry-limit", ConnectionCounters.slug("CFW recovery retry limit"))
        assertEquals("left-arm-not-found", ConnectionCounters.slug("left arm not found"))
        assertEquals("evenhub-resume-prelude-failed", ConnectionCounters.slug("EvenHub resume prelude failed"))
    }
}
