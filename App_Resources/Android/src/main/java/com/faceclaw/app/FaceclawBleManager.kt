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
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

@SuppressLint("MissingPermission")
class FaceclawBleManager(context: Context) {
    companion object {
        private const val TAG = "FaceclawBle"
        private val WRITE_RETRY_DELAYS_MS = intArrayOf(1, 1, 1, 2, 4, 8, 12, 20, 35, 100, 200)

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

    private val context: Context
    private val bluetoothAdapter: BluetoothAdapter
    private val mainHandler = Handler(Looper.getMainLooper())

    private val gattClients = ConcurrentHashMap<String, BluetoothGatt>()
    private val bluetoothApiLock = Any()

    private val connectLatches = ConcurrentHashMap<String, CountDownLatch>()
    private val connectResults = ConcurrentHashMap<String, Boolean>()

    private val servicesLatches = ConcurrentHashMap<String, CountDownLatch>()
    private val servicesStatuses = ConcurrentHashMap<String, Int>()

    private val mtuLatches = ConcurrentHashMap<String, CountDownLatch>()
    private val negotiatedMtus = ConcurrentHashMap<String, Int>()
    private val mtuStatuses = ConcurrentHashMap<String, Int>()

    private val descriptorLatches = ConcurrentHashMap<String, CountDownLatch>()
    private val descriptorStatuses = ConcurrentHashMap<String, Int>()

    private val writeLatches = ConcurrentHashMap<String, CountDownLatch>()
    private val writeStatuses = ConcurrentHashMap<String, Int>()

    @Volatile
    private var listener: FaceclawBleListener? = null

    init {
        this.context = context.applicationContext
        val bluetoothManager = this.context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?
        if (bluetoothManager == null || bluetoothManager.adapter == null) {
            throw IllegalStateException("Bluetooth adapter unavailable")
        }
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

    /** Whether a GATT client for this address is open, i.e. no disconnect callback has arrived for it. */
    fun isConnected(address: String?): Boolean {
        return address != null && gattClients.containsKey(address)
    }

    fun connect(address: String?, timeoutMs: Int): Boolean = connect(address, timeoutMs, false)

    /**
     * EXPERIMENTAL (2026-09-11): the ring specifically needs autoConnect=true.
     * Even's own vendor app connects the ring with Android's autoConnect flag
     * set (confirmed via its own BLE debug log, "connect() - device: ...,
     * auto: true"), while every other faceclaw connection (both glasses arms)
     * uses autoConnect=false. Direct connect (false) is faster to establish
     * but Android supervises it less patiently; a live test tonight showed
     * the ring-only direct connection dying almost exactly 5 seconds in,
     * repeatedly, with nothing else competing for it - consistent with a
     * companion device Android's stack expects to be babied via autoConnect,
     * not direct-connected like the glasses. autoConnect=true can take much
     * longer to actually complete (Android manages it as a background
     * reconnect, not an immediate attempt), so this needs its own longer
     * timeout - do not reuse CONNECT_TIMEOUT_MS/awaitLatch's short window for
     * it, that would just trade one spurious failure for another.
     */
    fun connect(address: String?, timeoutMs: Int, autoConnect: Boolean): Boolean {
        if (address == null || address.trim().isEmpty()) {
            throw IllegalArgumentException("address is required")
        }
        val latch = CountDownLatch(1)
        connectLatches[address] = latch
        connectResults.remove(address)

        val gattLock = gattLock(address)
        synchronized(gattLock) {
            val existing = gattClients[address]
            if (existing != null) {
                connectLatches.remove(address)
                return true
            }

            val device = bluetoothAdapter.getRemoteDevice(address)
            if (device == null) {
                connectLatches.remove(address)
                throw IllegalArgumentException("remote device not found: $address")
            }

            val gatt: BluetoothGatt? = device.connectGatt(
                context,
                autoConnect,
                gattCallback,
                BluetoothDevice.TRANSPORT_LE,
                BluetoothDevice.PHY_LE_2M or BluetoothDevice.PHY_LE_1M
            )
            if (gatt != null) {
                gattClients[address] = gatt
            }

            if (gatt == null) {
                connectLatches.remove(address)
                return false
            }

            if (!awaitLatch(latch, timeoutMs)) {
                connectLatches.remove(address)
                connectResults.remove(address)
                gattClients.remove(address, gatt)
                negotiatedMtus.remove(address)
                gatt.disconnect()
                gatt.close()
                return false
            }

            val connected = connectResults.remove(address)
            connectLatches.remove(address)
            return connected == true
        }
    }

    fun requestConnectionPriority(address: String, priority: Int): Boolean {
        synchronized(gattLock(address)) {
            val gatt = requireGatt(address)
            return gatt.requestConnectionPriority(priority)
        }
    }

    /** One-shot benchmark preferences; success is established by callbacks/HCI, not submission. */
    fun prepareBenchmarkLink(address: String, mode: Int) {
        synchronized(gattLock(address)) {
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
        synchronized(gattLock(address)) {
            val latch = CountDownLatch(1)
            mtuLatches[address] = latch
            mtuStatuses.remove(address)

            val gatt = requireGatt(address)
            val started = gatt.requestMtu(mtu)
            if (!started) {
                mtuLatches.remove(address)
                return false
            }
            if (!awaitLatch(latch, timeoutMs)) {
                mtuLatches.remove(address)
                mtuStatuses.remove(address)
                return false
            }
            val status = mtuStatuses.remove(address)
            mtuLatches.remove(address)
            return status != null && status == BluetoothGatt.GATT_SUCCESS
        }
    }

    fun discoverServices(address: String, timeoutMs: Int): Boolean {
        synchronized(gattLock(address)) {
            val latch = CountDownLatch(1)
            servicesLatches[address] = latch
            servicesStatuses.remove(address)

            val gatt = requireGatt(address)
            val started = gatt.discoverServices()
            if (!started) {
                servicesLatches.remove(address)
                return false
            }
            if (!awaitLatch(latch, timeoutMs)) {
                servicesLatches.remove(address)
                servicesStatuses.remove(address)
                return false
            }
            val status = servicesStatuses.remove(address)
            servicesLatches.remove(address)
            return status != null && status == BluetoothGatt.GATT_SUCCESS
        }
    }

    fun enableNotifications(address: String, characteristicUuid: String, enable: Boolean, timeoutMs: Int): Boolean {
        synchronized(gattLock(address)) {
            val latch = CountDownLatch(1)
            descriptorLatches[address] = latch
            descriptorStatuses.remove(address)

            val gatt = requireGatt(address)
            val characteristic = requireCharacteristic(gatt, characteristicUuid)

            val notificationSet = gatt.setCharacteristicNotification(characteristic, enable)
            if (!notificationSet) {
                descriptorLatches.remove(address)
                return false
            }

            val descriptor = characteristic.getDescriptor(java.util.UUID.fromString(BleProtocol.CCCD_UUID))
            if (descriptor == null) {
                descriptorLatches.remove(address)
                return true
            }

            descriptor.value = if (enable)
                BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            else
                BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            val started = gatt.writeDescriptor(descriptor)
            if (!started) {
                descriptorLatches.remove(address)
                descriptorStatuses.remove(address)
                return false
            }
            if (!awaitLatch(latch, timeoutMs)) {
                descriptorLatches.remove(address)
                descriptorStatuses.remove(address)
                return false
            }
            val status = descriptorStatuses.remove(address)
            descriptorLatches.remove(address)
            return status != null && status == BluetoothGatt.GATT_SUCCESS
        }
    }

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
        synchronized(gattLock(address)) {
            val gatt = requireGatt(address)
            val characteristic = requireCharacteristic(gatt, characteristicUuid)

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
            val latch = CountDownLatch(1)
            writeLatches[address] = latch
            writeStatuses.remove(address)

            val currentTime = System.currentTimeMillis()
            val result = gatt.writeCharacteristic(characteristic, data!!, writeType)
            val timeAsleep = System.currentTimeMillis() - currentTime
            //Log.i(TAG, "writeCharacteristic: spent " + timeAsleep + "ms");

            if (result == android.bluetooth.BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY) {
                writeLatches.remove(address, latch)
                writeStatuses.remove(address)
                if (!sleepBeforeWriteRetry(address, "busy", retryCount++)) {
                    return false
                }
                continue
            } else {
                //Log.i(TAG, "writeCharacteristic with writeType=" + writeType + " result=" + result + " retryCount=" + retryCount);
                if (result != android.bluetooth.BluetoothStatusCodes.SUCCESS) {
                    writeLatches.remove(address, latch)
                    writeStatuses.remove(address)
                    if (!sleepBeforeWriteRetry(address, "start result=$result", retryCount++)) {
                        return false
                    }
                    continue
                }
                if (!awaitLatch(latch, timeoutMs)) {
                    writeLatches.remove(address, latch)
                    writeStatuses.remove(address)
                    return false
                }
                val status = writeStatuses.remove(address)
                writeLatches.remove(address)
                if (status != null && status == BluetoothGatt.GATT_SUCCESS) {
                    return true
                }
                if (!sleepBeforeWriteRetry(address, "callback status=$status", retryCount++)) {
                    return false
                }
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

    fun disconnect(address: String?) {
        val gattLock = gattLock(address)
        synchronized(gattLock) {
            val gatt = if (address != null) gattClients.remove(address) else null
            if (address != null) negotiatedMtus.remove(address)
            if (gatt == null) {
                return
            }
            gatt.disconnect()
            gatt.close()
        }
    }

    fun close() {
        for (address in gattClients.keys) {
            disconnect(address)
        }
    }

    private fun requireGatt(address: String): BluetoothGatt {
        val gatt = gattClients[address]
        if (gatt == null) {
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

    private fun gattLock(address: String?): Any {
        // Android's Bluetooth stack has process-wide command-pipeline constraints on some devices.
        // Keep every BluetoothGatt API call serialized globally, even for different MAC addresses.
        return bluetoothApiLock
    }

    private val gattCallback: BluetoothGattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            Log.i(TAG, "onConnectionStateChange: status=$status newState=$newState")
            val address = gatt.device.address

            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                connectResults[address] = true
                val latch = connectLatches.remove(address)
                latch?.countDown()
                dispatchConnectionState(address, true)
                return
            }

            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                connectResults[address] = false
                val latch = connectLatches.remove(address)
                latch?.countDown()
                val gattLock = gattLock(address)
                synchronized(gattLock) {
                    gattClients.remove(address, gatt)
                    negotiatedMtus.remove(address)
                    gatt.close()
                }
                dispatchConnectionState(address, false)
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val address = gatt.device.address
            servicesStatuses[address] = status
            val latch = servicesLatches.remove(address)
            latch?.countDown()
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            val address = gatt.device.address
            if (status == BluetoothGatt.GATT_SUCCESS) negotiatedMtus[address] = mtu
            mtuStatuses[address] = status
            val latch = mtuLatches.remove(address)
            latch?.countDown()
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
            val address = gatt.device.address
            descriptorStatuses[address] = status
            val latch = descriptorLatches.remove(address)
            latch?.countDown()
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            val address = gatt.device.address
            writeStatuses[address] = status
            val latch = writeLatches.remove(address)
            latch?.countDown()
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            dispatchNotification(gatt.device.address, characteristic.uuid.toString(), value)
        }

        @Deprecated("Deprecated in Java")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            dispatchNotification(gatt.device.address, characteristic.uuid.toString(), characteristic.value)
        }
    }

    private fun dispatchConnectionState(address: String, connected: Boolean) {
        val current = listener ?: return
        current.onConnectionStateChange(address, connected)
    }

    private fun dispatchNotification(address: String, characteristicUuid: String, data: ByteArray?) {
        val current = listener ?: return
        val copy = data?.clone() ?: ByteArray(0)
        current.onNotification(address, characteristicUuid, copy)
    }
}
