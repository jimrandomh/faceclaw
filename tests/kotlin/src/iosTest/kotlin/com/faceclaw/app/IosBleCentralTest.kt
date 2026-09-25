package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertTrue
import platform.Foundation.NSDate
import platform.Foundation.NSDefaultRunLoopMode
import platform.Foundation.NSRunLoop
import platform.Foundation.NSThread
import platform.Foundation.dateWithTimeIntervalSinceNow
import platform.Foundation.runMode

class IosBleCentralTest {
    /** Registering a state listener must create the central and report a state without any scan. */
    @Test
    fun scanListenerAloneReceivesABluetoothStateReport() {
        val central = IosBleCentral(IosProtocolPlatform)
        val states = ArrayList<Int>()
        var offMain = 0
        central.setScanListener(object : IosBleScanListener {
            override fun onBluetoothState(state: Int, authorization: Int) {
                if (!NSThread.isMainThread) offMain++
                states.add(state)
            }

            override fun onAdvertisement(identifier: String, name: String, manufacturerDataHex: String, rssi: Int, connectable: Boolean) {}
        })
        val deadline = IosProtocolPlatform.elapsedRealtimeMs() + 5_000
        while (IosProtocolPlatform.elapsedRealtimeMs() < deadline && states.none { it != 0 }) {
            NSRunLoop.mainRunLoop.runMode(NSDefaultRunLoopMode, NSDate.dateWithTimeIntervalSinceNow(0.02))
        }
        // The simulator reports unsupported/powered-off; a real phone powered-on. Any non-unknown state proves the central exists.
        assertTrue(states.any { it != 0 }, "no CBManagerState reported: $states")
        assertTrue(offMain == 0, "state reports must arrive on the main queue")
        central.close()
    }
}
