package com.faceclaw.app

import android.os.SystemClock

class InterruptibleSleep {
    private val lock = java.lang.Object()
    private var interrupted = false

    fun sleep(ms: Long): Boolean {
        val delayMs = Math.max(1L, ms)
        val deadline = SystemClock.elapsedRealtime() + delayMs
        synchronized(lock) {
            // Consume (do not clear-and-ignore) an interrupt delivered before this
            // sleep began. interrupt() runs on other threads with no lock held by
            // the sleeper between driveSession() returning and sleep() starting, so
            // clearing the flag at entry lost that wake and forced the worker to
            // sleep the full interval — up to 250ms per idle frame. Honoring it
            // costs at most one extra (cheap) driveSession pass.
            if (interrupted) {
                interrupted = false
                return false
            }
            while (true) {
                val remaining = deadline - SystemClock.elapsedRealtime()
                if (remaining <= 0) {
                    return true
                }
                try {
                    lock.wait(remaining)
                } catch (ignored: InterruptedException) {
                    interrupted = false
                    return false
                }
                if (interrupted) {
                    interrupted = false
                    return false
                }
            }
        }
    }

    fun interrupt() {
        synchronized(lock) {
            interrupted = true
            lock.notifyAll()
        }
    }
}
