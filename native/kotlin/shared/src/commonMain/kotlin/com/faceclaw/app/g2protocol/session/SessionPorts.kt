package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.contracts.ExperimentalContracts
import kotlin.contracts.InvocationKind
import kotlin.contracts.contract

/**
 * GATT transport used by [GlassesSessionCore]. Addresses are opaque strings (Android MAC
 * addresses, CoreBluetooth identifiers on iOS); every call blocks the calling thread until the
 * operation completes or [timeoutMs] elapses, exactly like Android's FaceclawBleManager. Inbound
 * traffic reaches the core through its FaceclawBleListener methods, which the implementation
 * must call from whatever thread the platform stack delivers on.
 */
interface SessionLink {
    fun connect(address: String, timeoutMs: Int): Boolean

    /** Best effort; no completion point (see connectArm). */
    fun requestHighPriority(address: String)

    fun requestMtu(address: String, mtu: Int, timeoutMs: Int): Boolean

    fun negotiatedMtu(address: String): Int

    fun discoverServices(address: String, timeoutMs: Int): Boolean

    fun enableNotifications(address: String, characteristicUuid: String, enable: Boolean, timeoutMs: Int): Boolean

    fun writeFrames(
        address: String,
        characteristicUuid: String,
        frames: List<ByteArray>,
        mode: GattWriteMode,
        timeoutMs: Int,
    ): Boolean

    fun disconnect(address: String)

    fun close()

    /** Whether the OS still holds a pairing bond for the address (iOS: always true). */
    fun isBonded(address: String): Boolean

    /** Bandwidth-benchmark link tuning; 0: current link, 1: HIGH priority, 2: 2M PHY, 3: both. */
    fun prepareBenchmarkLink(address: String, mode: Int)

    /** Traffic counter hook: one display frame fully acknowledged. */
    fun recordDisplayFrameSent()
}

/** Delivers an action on a specific thread (a Looper, a dispatch queue, ...). */
fun interface SessionDispatcher {
    fun post(action: () -> Unit)
}

enum class SessionLogLevel {
    DEBUG,
    INFO,
    WARN,
    ERROR,
}

/**
 * Platform side effects the session core needs. Listener callbacks are marshalled through
 * [postToMain]; everything else is a synchronous query or command on the calling thread.
 */
interface SessionHost {
    fun postToMain(action: () -> Unit)

    /** A dispatcher for the calling thread (its Looper/queue), falling back to the main thread. */
    fun currentThreadDispatcher(): SessionDispatcher

    fun isPhoneLocked(): Boolean

    /** Hold (true) or release (false) the "glasses screen on" wake lock; idempotent. */
    fun setScreenWakeLock(on: Boolean)

    /** Whether the stock Even app appears active (it can hold the BLE link). */
    fun isEvenAppActive(): Boolean

    /** Start the worker thread that runs [body] (the core's run loop) once. */
    fun startWorker(body: () -> Unit)

    /** Interrupt (where supported) and wait up to [timeoutMs] for the worker started by [startWorker]. */
    fun joinWorker(timeoutMs: Long)

    fun log(level: SessionLogLevel, tag: String, message: String, error: Throwable?)
}

/**
 * Java-monitor replacement: a reentrant state lock plus a separate condition used only at the
 * blocking wait sites. Waiters must hold [lock] exactly once when calling [awaitMs]; notifiers
 * may hold it (they normally do). Ordering is always lock -> signal, and the waiter never holds
 * the signal while acquiring the lock, so the pair cannot deadlock and cannot lose a wake-up:
 * the predicate is checked under [lock], the signal is taken before [lock] is released, and
 * [ProtocolCondition.awaitMs] releases the signal atomically.
 */
internal class SessionMonitor(platform: ProtocolPlatform) {
    val lock: ProtocolLock = platform.createLock()
    private val signal: ProtocolCondition = platform.createCondition()

    fun signalAll() {
        signal.lock()
        try {
            signal.signalAll()
        } finally {
            signal.unlock()
        }
    }

    /** Caller holds [lock] once; returns with it held again. Spurious wake-ups are possible. */
    fun awaitMs(timeoutMs: Long) {
        signal.lock()
        lock.unlock()
        try {
            signal.awaitMs(timeoutMs)
        } finally {
            signal.unlock()
        }
        lock.lock()
    }
}

/** Snapshot-iterated listener list (java.util.concurrent.CopyOnWriteArrayList stand-in). */
internal class CopyOnWriteList<T>(platform: ProtocolPlatform) : Iterable<T> {
    private val lock = platform.createLock()

    @Volatile private var items: List<T> = emptyList()

    fun add(item: T) {
        lock.withLock { items = items + item }
    }

    fun remove(item: T) {
        lock.withLock { items = items - item }
    }

    fun isEmpty(): Boolean = items.isEmpty()

    override fun iterator(): Iterator<T> = items.iterator()
}

/** Runs [action] under the monitor's state lock; the contract lets `val`s be assigned inside, like `synchronized`. */
@OptIn(ExperimentalContracts::class)
internal inline fun <T> SessionMonitor.withLock(action: () -> T): T {
    contract { callsInPlace(action, InvocationKind.EXACTLY_ONCE) }
    lock.lock()
    try {
        return action()
    } finally {
        lock.unlock()
    }
}

/** [ProtocolLock.withLock] with a call-in-place contract. */
@OptIn(ExperimentalContracts::class)
internal inline fun <T> ProtocolLock.locked(action: () -> T): T {
    contract { callsInPlace(action, InvocationKind.EXACTLY_ONCE) }
    lock()
    try {
        return action()
    } finally {
        unlock()
    }
}
