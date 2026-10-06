package com.faceclaw.app

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.util.Log

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

@SuppressLint("MissingPermission")
class FaceclawBleManager(context: Context) {
    companion object {
        private const val TAG = "FaceclawBle"
        private val WRITE_RETRY_DELAYS_MS = intArrayOf(1, 1, 1, 2, 4, 8, 12, 20, 35, 100, 200)

        // Handed to an operation waiter whose link dropped before its completion
        // callback arrived; never a real GATT status.
        private const val STATUS_LINK_LOST = -1

        // Android's Bluetooth stack has process-wide command-pipeline constraints on some
        // devices, so every GATT operation in the process is serialized on this one lock,
        // across manager instances too (the session and each stock-firmware flow own one).
        // An operation holds it until its completion callback; waiting for a connection
        // to come up, or backing off before a write retry, does not.
        private val bluetoothApiLock = Any()

        // Listener callbacks run here, in arrival order, instead of on the binder thread
        // that delivered them. BluetoothGatt's callback interface is oneway, so a listener
        // that blocks (the session core waits for its monitor) would otherwise hold back
        // every later callback for that device, including the write completion that the
        // monitor's holder may itself be waiting for.
        private val callbackExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "FaceclawBleCallbacks").apply { isDaemon = true }
        }

        // Process-wide outbound-traffic totals, sampled by the phone UI's BLE
        // bandwidth indicator. Static so counts from every manager instance and
        // isolate land in the same totals.
        private val outboundMessages = AtomicLong()
        private val outboundBytes = AtomicLong()
        private val displayFramesSent = AtomicLong()

        /** Called by the communicator when a display frame's last message is acked. */
        @JvmStatic
        fun recordDisplayFrameSent() {
            displayFramesSent.incrementAndGet()
        }

        /** Running totals of outbound BLE traffic since process start: [messages, bytes, display frames]. */
        @JvmStatic
        fun sampleOutboundTraffic(): LongArray {
            return longArrayOf(outboundMessages.get(), outboundBytes.get(), displayFramesSent.get())
        }
    }

    /**
     * One BluetoothGatt client for an address: a pending connection attempt until
     * [connected]. [gatt] is set once connectGatt returns; a callback can arrive before
     * that, while it is still null.
     */
    private class GattLink {
        @Volatile var gatt: BluetoothGatt? = null
        @Volatile var connected = false
        val connectLatch = CountDownLatch(1)
    }

    private enum class OpKind { MTU, SERVICES, DESCRIPTOR, WRITE }

    /** The GATT operation awaiting its completion callback (the global lock allows one at a time). */
    private class PendingOp(val address: String, val kind: OpKind) {
        val latch = CountDownLatch(1)
        @Volatile var status: Int? = null
    }

    private val context: Context
    private val bluetoothManager: BluetoothManager
    private val bluetoothAdapter: BluetoothAdapter

    private val links = ConcurrentHashMap<String, GattLink>()
    private val negotiatedMtus = ConcurrentHashMap<String, Int>()
    private val messageLocks = ConcurrentHashMap<String, Any>()

    @Volatile
    private var pendingOp: PendingOp? = null

    @Volatile
    private var listener: FaceclawBleListener? = null

    init {
        this.context = context.applicationContext
        val bluetoothManager = this.context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?
        if (bluetoothManager == null || bluetoothManager.adapter == null) {
            throw IllegalStateException("Bluetooth adapter unavailable")
        }
        this.bluetoothManager = bluetoothManager
        this.bluetoothAdapter = bluetoothManager.adapter
    }

    fun setListener(listener: FaceclawBleListener?) {
        this.listener = listener
    }

    /**
     * Whether Android still holds a bond (pairing) for this address. Returns
     * true when the state cannot be determined, so callers only act on a
     * definite BOND_NONE.
     */
    fun isBonded(address: String?): Boolean {
        if (address == null || address.trim().isEmpty()) {
            return true
        }
        try {
            val device = bluetoothAdapter.getRemoteDevice(address)
            return device == null || device.bondState != BluetoothDevice.BOND_NONE
        } catch (t: Throwable) {
            return true
        }
    }

    /**
     * Android's bond state for this address (BluetoothDevice.BOND_NONE /
     * BOND_BONDING / BOND_BONDED), or -1 when it cannot be determined.
     * BOND_BONDING covers the whole OS pairing flow, including a pairing
     * dialog that is still waiting for the user.
     */
    fun getBondState(address: String?): Int {
        if (address == null || address.trim().isEmpty()) {
            return -1
        }
        try {
            val device = bluetoothAdapter.getRemoteDevice(address)
            return if (device == null) -1 else device.bondState
        } catch (t: Throwable) {
            return -1
        }
    }

    /** Whether a connection to this address is up (not merely pending). */
    fun isConnected(address: String?): Boolean {
        return address != null && links[address]?.connected == true
    }

    /**
     * Start connecting without waiting; a later [connect] waits on the same attempt.
     * [background] uses Android's autoConnect: a low-duty-cycle attempt with no timeout
     * that lands whenever the device next advertises (a direct attempt scans hard but
     * gives up after about 30 s). Returns true while a connection exists or is pending.
     */
    fun beginConnect(address: String?, background: Boolean): Boolean {
        return startConnect(requireAddress(address), background) != null
    }

    fun connect(address: String?, timeoutMs: Int): Boolean = connect(address, timeoutMs, false)

    /**
     * EXPERIMENTAL (2026-09-11): the ring specifically needs autoConnect=true.
     * Even's own vendor app connects the ring with Android's autoConnect flag
     * set (confirmed via its own BLE debug log, "connect() - device: ...,
     * auto: true"), while every other faceclaw connection (both glasses arms)
     * uses autoConnect=false. Direct connect (false) is faster to establish
     * but Android supervises it less patiently; a live test showed the
     * ring-only direct connection dying almost exactly 5 seconds in,
     * repeatedly, with nothing else competing for it. autoConnect=true can
     * take much longer to actually complete (Android manages it as a
     * background reconnect, not an immediate attempt), so this needs its own
     * longer timeout. Like [connect], waits on an attempt already pending.
     */
    fun connect(address: String?, timeoutMs: Int, autoConnect: Boolean): Boolean {
        val key = requireAddress(address)
        val link = startConnect(key, autoConnect) ?: return false
        if (link.connected) {
            return true
        }
        if (!awaitLatch(link.connectLatch, timeoutMs)) {
            Log.w(TAG, "connect timed out after ${timeoutMs}ms: address=$key"
                + " (no connection event; the device may not be advertising, or may be connected to something else)")
            dropLink(key, link)
            return false
        }
        return link.connected
    }

    /** The current client for [address], starting a connection attempt when there is none. */
    private fun startConnect(address: String, background: Boolean): GattLink? {
        synchronized(bluetoothApiLock) {
            val existing = links[address]
            if (existing != null) {
                if (!existing.connected || isOsConnected(existing)) {
                    return existing
                }
                // A client can go stale without a disconnect callback (the Bluetooth
                // service drops its clients when the adapter turns off).
                Log.w(TAG, "dropping stale client: address=$address (Android reports no GATT connection)")
                dropLink(address, existing)
            }
            val device = bluetoothAdapter.getRemoteDevice(address)
            val link = GattLink()
            links[address] = link
            val gatt: BluetoothGatt? = device.connectGatt(
                context,
                background,
                gattCallback,
                BluetoothDevice.TRANSPORT_LE,
                BluetoothDevice.PHY_LE_2M or BluetoothDevice.PHY_LE_1M
            )
            if (gatt == null) {
                links.remove(address, link)
                Log.w(TAG, "connectGatt returned null: address=$address")
                return null
            }
            link.gatt = gatt
            Log.i(TAG, "connect started: address=$address background=$background")
            return link
        }
    }

    private fun isOsConnected(link: GattLink): Boolean {
        val gatt = link.gatt ?: return false
        return try {
            bluetoothManager.getConnectionState(gatt.device, BluetoothProfile.GATT) == BluetoothProfile.STATE_CONNECTED
        } catch (t: Throwable) {
            true
        }
    }

    fun requestConnectionPriority(address: String, priority: Int): Boolean {
        synchronized(bluetoothApiLock) {
            val gatt = requireGatt(address)
            return gatt.requestConnectionPriority(priority)
        }
    }

    /** One-shot benchmark preferences; success is established by callbacks/HCI, not submission. */
    fun prepareBenchmarkLink(address: String, mode: Int) {
        synchronized(bluetoothApiLock) {
            val gatt = requireGatt(address)
            if ((mode and 1) != 0) {
                val accepted = gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                Log.i(TAG, "benchmark HIGH address=$address submitted=$accepted")
            }
            if ((mode and 2) != 0) {
                Log.i(TAG, "benchmark request 2M address=$address")
                gatt.setPreferredPhy(BluetoothDevice.PHY_LE_2M_MASK,
                    BluetoothDevice.PHY_LE_2M_MASK, BluetoothDevice.PHY_OPTION_NO_PREFERRED)
            }
            gatt.readPhy()
        }
    }

    fun getNegotiatedMtu(address: String): Int {
        val mtu = negotiatedMtus[address]
        return mtu ?: 23
    }

    fun requestMtu(address: String, mtu: Int, timeoutMs: Int): Boolean {
        val status = runOp(address, OpKind.MTU, timeoutMs) { gatt -> gatt.requestMtu(mtu) }
        return status == BluetoothGatt.GATT_SUCCESS
    }

    fun discoverServices(address: String, timeoutMs: Int): Boolean {
        val status = runOp(address, OpKind.SERVICES, timeoutMs) { gatt -> gatt.discoverServices() }
        return status == BluetoothGatt.GATT_SUCCESS
    }

    fun enableNotifications(address: String, characteristicUuid: String, enable: Boolean, timeoutMs: Int): Boolean {
        synchronized(bluetoothApiLock) {
            val gatt = requireGatt(address)
            val characteristic = requireCharacteristic(gatt, characteristicUuid)

            val notificationSet = gatt.setCharacteristicNotification(characteristic, enable)
            if (!notificationSet) {
                return false
            }

            val descriptor = characteristic.getDescriptor(java.util.UUID.fromString(BleProtocol.CCCD_UUID))
            if (descriptor == null) {
                return true
            }

            descriptor.value = if (enable)
                BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            else
                BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            val status = runOp(address, OpKind.DESCRIPTOR, timeoutMs) { client -> client.writeDescriptor(descriptor) }
            return status == BluetoothGatt.GATT_SUCCESS
        }
    }

    /**
     * Start one GATT operation and wait for its completion callback, holding the global
     * lock throughout. Returns the callback's status ([STATUS_LINK_LOST] when the link
     * dropped first), or null when Android refused the request or it timed out.
     */
    private fun runOp(address: String, kind: OpKind, timeoutMs: Int, start: (BluetoothGatt) -> Boolean): Int? {
        synchronized(bluetoothApiLock) {
            val op = PendingOp(address, kind)
            // Published before the connected check in requireGatt, so a disconnect racing
            // with this start either fails that check or finds the op to release.
            pendingOp = op
            try {
                val gatt = requireGatt(address)
                if (!start(gatt)) {
                    Log.w(TAG, "$kind not started: address=$address")
                    return null
                }
                if (!awaitLatch(op.latch, timeoutMs)) {
                    Log.w(TAG, "$kind timed out after ${timeoutMs}ms: address=$address")
                    return null
                }
                if (op.status == STATUS_LINK_LOST) {
                    Log.w(TAG, "$kind abandoned: link lost: address=$address")
                }
                return op.status
            } finally {
                pendingOp = null
            }
        }
    }

    /**
     * Writes [frames] in order. The global API lock is held for each frame's
     * write-and-callback (one GATT operation in flight process-wide), but not
     * across the whole message or during retry backoff, so a slow or failing
     * link (the direct ring) can't hold the glasses off the air for a whole
     * retry cycle. The per-address lock keeps concurrent messages to the same
     * device from interleaving their frames.
     */
    fun writeFrames(
        address: String,
        characteristicUuid: String,
        frames: List<ByteArray?>?,
        writeType: Int,
        timeoutMs: Int
    ): Boolean {
        if (frames == null || frames.isEmpty()) {
            return true
        }

        val startMs = System.currentTimeMillis()
        synchronized(messageLock(address)) {
            val gatt: BluetoothGatt
            val characteristic: BluetoothGattCharacteristic
            synchronized(bluetoothApiLock) {
                gatt = requireGatt(address)
                characteristic = requireCharacteristic(gatt, characteristicUuid)
            }

            for (i in frames.indices) {
                val frame = frames[i]
                if (!startWrite(gatt, characteristic, address, frame, writeType, timeoutMs)) {
                    return false
                }
                outboundBytes.addAndGet((frame?.size ?: 0).toLong())
            }
        }
        outboundMessages.incrementAndGet()
        val totalSize = frames.sumOf { frame -> frame?.size ?: 0 }
        Log.i(TAG, "writeFrames wrote " + frames.size + " frames totaling " + totalSize + " bytes in " + (System.currentTimeMillis() - startMs) + "ms")
        return true
    }

    private fun startWrite(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        address: String,
        data: ByteArray?,
        writeType: Int,
        timeoutMs: Int
    ): Boolean {
        var retryCount = 0
        while (true) {
            val retryReason: String
            synchronized(bluetoothApiLock) {
                val op = PendingOp(address, OpKind.WRITE)
                pendingOp = op
                try {
                    // The lock is released between frames and retries, so the client may
                    // have dropped (or been replaced by a reconnect) since the write started.
                    if (!isCurrentClient(address, gatt)) {
                        Log.w(TAG, "writeCharacteristic abandoned: link lost: address=$address")
                        return false
                    }
                    val result = gatt.writeCharacteristic(characteristic, data!!, writeType)
                    if (result != android.bluetooth.BluetoothStatusCodes.SUCCESS) {
                        if (!isCurrentClient(address, gatt)) {
                            Log.w(TAG, "writeCharacteristic abandoned: link lost: address=$address")
                            return false
                        }
                        retryReason = if (result == android.bluetooth.BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY)
                            "busy"
                        else
                            "start result=$result"
                    } else {
                        if (!awaitLatch(op.latch, timeoutMs)) {
                            Log.w(TAG, "writeCharacteristic timed out after ${timeoutMs}ms waiting for completion: address=$address")
                            return false
                        }
                        val status = op.status
                        if (status == BluetoothGatt.GATT_SUCCESS) {
                            return true
                        }
                        if (status == STATUS_LINK_LOST) {
                            Log.w(TAG, "writeCharacteristic abandoned: link lost: address=$address")
                            return false
                        }
                        retryReason = "callback status=$status"
                    }
                } finally {
                    pendingOp = null
                }
            }
            // Back off outside the lock so other devices' operations proceed.
            if (!sleepBeforeWriteRetry(address, retryReason, retryCount++)) {
                return false
            }
        }
    }

    private fun sleepBeforeWriteRetry(address: String, reason: String, retryIndex: Int): Boolean {
        if (retryIndex >= WRITE_RETRY_DELAYS_MS.size) {
            Log.w(TAG, "writeCharacteristic retry exhausted: address=$address reason=$reason")
            return false
        }
        val delayMs = WRITE_RETRY_DELAYS_MS[retryIndex]
        Log.w(TAG, "writeCharacteristic retry: address=$address reason=$reason delayMs=$delayMs")
        try {
            Thread.sleep(delayMs.toLong())
            return true
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return false
        }
    }

    /** Close this address's client, cancelling a pending connection attempt. */
    fun disconnect(address: String?) {
        if (address == null) {
            return
        }
        val link = links[address] ?: return
        dropLink(address, link)
    }

    fun close() {
        for (address in links.keys) {
            disconnect(address)
        }
    }

    /**
     * Forget [link] if it is still current for [address], release anything waiting on it,
     * then disconnect and close its client. Closing suppresses the client's remaining
     * callbacks, so listeners hear nothing about a link dropped here.
     */
    private fun dropLink(address: String, link: GattLink) {
        if (!links.remove(address, link)) {
            return
        }
        link.connected = false
        negotiatedMtus.remove(address)
        failPendingOp(address)
        link.connectLatch.countDown()
        // startConnect holds the lock until link.gatt is set, so it is set by the time
        // this block runs (or connectGatt failed and there is nothing to close).
        synchronized(bluetoothApiLock) {
            val gatt = link.gatt ?: return
            gatt.disconnect()
            gatt.close()
        }
    }

    private fun failPendingOp(address: String) {
        val op = pendingOp
        if (op != null && op.address == address && op.latch.count > 0) {
            op.status = STATUS_LINK_LOST
            op.latch.countDown()
        }
    }

    private fun completeOp(address: String, kind: OpKind, status: Int) {
        val op = pendingOp
        if (op != null && op.address == address && op.kind == kind) {
            op.status = status
            op.latch.countDown()
        }
    }

    /** Whether [gatt] is still the connected client for [address]. */
    private fun isCurrentClient(address: String, gatt: BluetoothGatt): Boolean {
        val link = links[address]
        return link != null && link.connected && link.gatt === gatt
    }

    /** Serializes whole multi-frame messages per device; taken before [bluetoothApiLock], never after. */
    private fun messageLock(address: String): Any {
        return messageLocks.getOrPut(address) { Any() }
    }

    private fun requireAddress(address: String?): String {
        if (address == null || address.trim().isEmpty()) {
            throw IllegalArgumentException("address is required")
        }
        return address
    }

    private fun requireGatt(address: String): BluetoothGatt {
        val link = links[address]
        val gatt = link?.gatt
        if (link == null || gatt == null || !link.connected) {
            throw IllegalStateException("Not connected: $address")
        }
        return gatt
    }

    private fun requireCharacteristic(gatt: BluetoothGatt, characteristicUuid: String): BluetoothGattCharacteristic {
        val target = UUID.fromString(characteristicUuid)
        for (service: BluetoothGattService in gatt.services) {
            val characteristic = service.getCharacteristic(target)
            if (characteristic != null) {
                return characteristic
            }
        }
        throw IllegalStateException("Characteristic not found: $characteristicUuid")
    }

    private fun awaitLatch(latch: CountDownLatch, timeoutMs: Int): Boolean {
        try {
            return latch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return false
        }
    }

    private val gattCallback: BluetoothGattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val address = gatt.device.address
            Log.i(TAG, "onConnectionStateChange: address=$address status=$status newState=$newState")
            val link = links[address]
            val current = link?.gatt
            if (link == null || (current != null && current !== gatt)) {
                // A client this manager no longer tracks: make sure it is released.
                synchronized(bluetoothApiLock) {
                    if (newState != BluetoothProfile.STATE_DISCONNECTED) gatt.disconnect()
                    gatt.close()
                }
                return
            }

            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                link.connected = true
                link.connectLatch.countDown()
                dispatchConnectionState(address, link, true)
                return
            }
            if (newState != BluetoothProfile.STATE_DISCONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                return
            }

            // Disconnected, or a failed attempt (including a connection reported with an
            // error status). Wake the waiters first: the lock below may be held by one of
            // them, waiting for a callback that will now never come.
            links.remove(address, link)
            link.connected = false
            negotiatedMtus.remove(address)
            failPendingOp(address)
            link.connectLatch.countDown()
            dispatchConnectionState(address, link, false)
            synchronized(bluetoothApiLock) {
                if (newState != BluetoothProfile.STATE_DISCONNECTED) gatt.disconnect()
                gatt.close()
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            completeOp(gatt.device.address, OpKind.SERVICES, status)
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            val address = gatt.device.address
            if (status == BluetoothGatt.GATT_SUCCESS) negotiatedMtus[address] = mtu
            completeOp(address, OpKind.MTU, status)
        }

        override fun onPhyRead(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) {
            Log.i(TAG, "onPhyRead: address=" + gatt.device.address
                + " txPhy=" + txPhy + " rxPhy=" + rxPhy + " status=" + status)
        }

        override fun onPhyUpdate(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) {
            Log.i(TAG, "onPhyUpdate: address=" + gatt.device.address
                + " txPhy=" + txPhy + " rxPhy=" + rxPhy + " status=" + status)
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            completeOp(gatt.device.address, OpKind.DESCRIPTOR, status)
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            completeOp(gatt.device.address, OpKind.WRITE, status)
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            dispatchNotification(gatt.device.address, characteristic.uuid.toString(), value)
        }

        @Deprecated("Deprecated in Java")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            dispatchNotification(gatt.device.address, characteristic.uuid.toString(), characteristic.value)
        }
    }

    private fun dispatchConnectionState(address: String, link: GattLink, connected: Boolean) {
        callbackExecutor.execute {
            // Drop news about a client that a newer attempt has already replaced.
            val current = links[address]
            if (if (connected) current !== link else current != null && current !== link) {
                return@execute
            }
            val target = listener ?: return@execute
            try {
                target.onConnectionStateChange(address, connected)
            } catch (t: Throwable) {
                Log.w(TAG, "connection-state listener failed: address=$address", t)
            }
        }
    }

    private fun dispatchNotification(address: String, characteristicUuid: String, data: ByteArray?) {
        val copy = data?.clone() ?: ByteArray(0)
        callbackExecutor.execute {
            val target = listener ?: return@execute
            try {
                target.onNotification(address, characteristicUuid, copy)
            } catch (t: Throwable) {
                Log.w(TAG, "notification listener failed: address=$address", t)
            }
        }
    }
}
