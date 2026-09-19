package com.faceclaw.app

import kotlin.test.Test

/** Existing wire fixtures also verify the Java API retained by the Kotlin port. */
class JavaCompatibilityTest {
    @Test fun compass() = CompassProtocolTest.main(emptyArray())

    @Test fun ringBattery() = RingBatteryProtocolTest.main(emptyArray())

    @Test fun gestures() = FaceclawGestureEventTest.main(emptyArray())

    @Test fun textureCache() = TextureCacheProtocolTest.main(emptyArray())
}

class AndroidByteReaderTest {
    @Test fun repeatedBridgeCrossingsHaveIndependentCursors() {
        val buffer = java.nio.ByteBuffer.wrap(byteArrayOf(10, 20, 30))
        val first = AndroidByteReader(buffer)
        kotlin.test.assertEquals(10, first.get().toInt())
        kotlin.test.assertEquals(0, buffer.position())
        val second = AndroidByteReader(buffer)
        kotlin.test.assertEquals(3, second.remaining())
        kotlin.test.assertEquals(10, second.get().toInt())
        kotlin.test.assertEquals(20, first.get().toInt())
    }
}
