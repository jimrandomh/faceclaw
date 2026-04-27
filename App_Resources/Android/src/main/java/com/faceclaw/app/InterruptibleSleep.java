package com.faceclaw.app;

import android.os.SystemClock;

final class InterruptibleSleep {
    private final Object lock = new Object();
    private boolean interrupted;

    boolean sleep(long ms) {
        long delayMs = Math.max(1, ms);
        long deadline = SystemClock.elapsedRealtime() + delayMs;
        synchronized (lock) {
            interrupted = false;
            while (!interrupted) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    interrupted = false;
                    return true;
                }
                try {
                    lock.wait(remaining);
                } catch (InterruptedException ignored) {
                    interrupted = false;
                    return false;
                }
            }
            interrupted = false;
            return false;
        }
    }

    void interrupt() {
        synchronized (lock) {
            interrupted = true;
            lock.notifyAll();
        }
    }
}
