package com.faceclaw.app

/**
 * Sleep that another thread can cut short. An interrupt delivered before the sleep begins is
 * consumed by the next sleep (returns false immediately) rather than lost: interrupt() runs on
 * other threads with no lock held by the sleeper between two work passes, so clearing the flag
 * at entry would force a full sleep interval. Returns true when the full duration elapsed.
 */
class InterruptibleSleep(private val platform: ProtocolPlatform = protocolPlatform()) {
    private val condition = platform.createCondition()
    private var interrupted = false

    fun sleep(ms: Long): Boolean {
        val deadline = platform.elapsedRealtimeMs() + maxOf(1L, ms)
        condition.lock()
        try {
            if (interrupted) {
                interrupted = false
                return false
            }
            while (true) {
                val remaining = deadline - platform.elapsedRealtimeMs()
                if (remaining <= 0) return true
                condition.awaitMs(remaining)
                if (interrupted) {
                    interrupted = false
                    return false
                }
            }
        } finally {
            condition.unlock()
        }
    }

    fun interrupt() {
        condition.withLock {
            interrupted = true
            condition.signalAll()
        }
    }
}

/** One-shot countdown; await returns true once the count reaches zero, false on timeout. */
class Latch(count: Int, private val platform: ProtocolPlatform = protocolPlatform()) {
    private val condition = platform.createCondition()
    private var remaining = count

    fun countDown() {
        condition.withLock {
            if (remaining > 0) remaining--
            if (remaining == 0) condition.signalAll()
        }
    }

    fun await(timeoutMs: Long): Boolean {
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        condition.withLock {
            while (remaining > 0) {
                val left = deadline - platform.elapsedRealtimeMs()
                if (left <= 0) return false
                condition.awaitMs(left)
            }
            return true
        }
    }
}

/** Unbounded FIFO handoff between threads with a timed poll. */
class BlockingQueue<T : Any>(private val platform: ProtocolPlatform = protocolPlatform()) {
    private val condition = platform.createCondition()
    private val items = ArrayDeque<T>()

    fun put(item: T) {
        condition.withLock {
            items.addLast(item)
            condition.signalAll()
        }
    }

    fun poll(timeoutMs: Long): T? {
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        condition.withLock {
            while (items.isEmpty()) {
                val left = deadline - platform.elapsedRealtimeMs()
                if (left <= 0) return null
                condition.awaitMs(left)
            }
            return items.removeFirst()
        }
    }

    fun clear() {
        condition.withLock { items.clear() }
    }

    val size: Int
        get() = condition.withLock { items.size }
}

/** Starts a platform thread running [body]; daemon threads never block process exit on the JVM. */
expect fun startThread(name: String, daemon: Boolean, body: () -> Unit)

expect fun sleepMs(ms: Long)

fun currentThreadName(): String = com.faceclaw.shared.PlatformInfo.threadName()
