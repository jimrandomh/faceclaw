@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlinx.cinterop.ObjCSignatureOverride
import platform.CoreBluetooth.CBAdvertisementDataIsConnectable
import platform.CoreBluetooth.CBAdvertisementDataLocalNameKey
import platform.CoreBluetooth.CBAdvertisementDataManufacturerDataKey
import platform.CoreBluetooth.CBCentralManager
import platform.CoreBluetooth.CBCentralManagerDelegateProtocol
import platform.CoreBluetooth.CBCentralManagerScanOptionAllowDuplicatesKey
import platform.CoreBluetooth.CBCharacteristic
import platform.CoreBluetooth.CBCharacteristicPropertyIndicate
import platform.CoreBluetooth.CBCharacteristicPropertyNotify
import platform.CoreBluetooth.CBCharacteristicPropertyWrite
import platform.CoreBluetooth.CBCharacteristicPropertyWriteWithoutResponse
import platform.CoreBluetooth.CBCharacteristicWriteType
import platform.CoreBluetooth.CBCharacteristicWriteWithResponse
import platform.CoreBluetooth.CBCharacteristicWriteWithoutResponse
import platform.CoreBluetooth.CBConnectPeripheralOptionRequiresANCS
import platform.CoreBluetooth.CBManager
import platform.CoreBluetooth.CBManagerStatePoweredOff
import platform.CoreBluetooth.CBManagerStatePoweredOn
import platform.CoreBluetooth.CBManagerStateUnauthorized
import platform.CoreBluetooth.CBManagerStateUnsupported
import platform.CoreBluetooth.CBPeripheral
import platform.CoreBluetooth.CBPeripheralDelegateProtocol
import platform.CoreBluetooth.CBPeripheralStateConnected
import platform.CoreBluetooth.CBPeripheralStateDisconnected
import platform.CoreBluetooth.CBService
import platform.Foundation.NSData
import platform.Foundation.NSError
import platform.Foundation.NSNumber
import platform.Foundation.NSUUID
import platform.darwin.NSObject
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue
import platform.darwin.dispatch_queue_create
import platform.darwin.dispatch_sync

/** Scan/state events for the phone-side device picker; delivered on the main queue. */
interface IosBleScanListener {
    /** CBManagerState raw value and CBManagerAuthorization raw value. */
    fun onBluetoothState(state: Int, authorization: Int)

    fun onAdvertisement(identifier: String, name: String, manufacturerDataHex: String, rssi: Int, connectable: Boolean)
}

/** ANCS authorization changes for a connected peripheral; delivered on the BLE queue. */
fun interface IosAncsAuthorizationListener {
    fun onAncsAuthorization(identifier: String, authorized: Boolean)
}

/**
 * CoreBluetooth central used by the shared session and stock-firmware flows on iOS. It is
 * the iOS counterpart of Android's FaceclawBleManager: every [SessionLink]/[StockLink] call
 * blocks the calling (worker) thread until the delegate reports completion or the timeout
 * elapses. CoreBluetooth runs on a private serial queue; the calling thread hands it work
 * with dispatch_sync and waits on a condition the delegate signals. Addresses are peripheral
 * identifier UUID strings (case-insensitive). Inbound notifications and connection-state
 * changes go to the registered listeners on the BLE queue; scan events go to the main queue.
 *
 * Locking: [cond] (non-reentrant) guards all peer state. It is never held across a
 * dispatch_sync or a listener callback.
 */
class IosBleCentral(private val platform: ProtocolPlatform = IosProtocolPlatform) : SessionLink, StockLink {
    companion object {
        const val TAG = "FaceclawBle"
        const val ADVERTISEMENT_CACHE = 512
        private const val READY_TIMEOUT_MS = 30_000
        private const val DEFAULT_ATT_MTU = 23
        private const val MAX_ATT_MTU = 517
    }

    private class Peer(val peripheral: CBPeripheral) {
        val identifier: String = peripheral.identifier.UUIDString.uppercase()
        val characteristics = HashMap<String, CBCharacteristic>()
        var connectPending = false
        var connected = false
        var failure: String? = null
        var discoverPending = false
        var pendingServices = 0
        var notifyPending: String? = null
        var notifyResult: Boolean? = null
        var writePending = false
        var writeError: String? = null
        var readyForWriteWithoutResponse = false
        var requiresAncs = false
        var reportedConnected = false
    }

    private class Advertisement(var name: String, var manufacturerDataHex: String)

    private val queue = dispatch_queue_create("com.faceclaw.ble", null)
    private val cond: ProtocolCondition = platform.createCondition()
    private val peers = HashMap<String, Peer>()
    private val advertisements = LinkedHashMap<String, Advertisement>()
    private val delegate = Delegate(this)
    private var central: CBCentralManager? = null

    @Volatile private var bluetoothState: Long = 0
    @Volatile private var scanRequested = false
    @Volatile private var scanListener: IosBleScanListener? = null
    @Volatile private var ancsListener: IosAncsAuthorizationListener? = null
    @Volatile private var sessionListener: FaceclawBleListener? = null
    @Volatile private var stockListener: StockLinkListener? = null
    @Volatile private var closed = false

    // ----- listeners ------------------------------------------------------------------

    /** The session core (a FaceclawBleListener); called on the BLE queue. */
    fun setSessionListener(listener: FaceclawBleListener?) {
        sessionListener = listener
    }

    override fun setListener(listener: StockLinkListener?) {
        stockListener = listener
    }

    fun setAncsAuthorizationListener(listener: IosAncsAuthorizationListener?) {
        ancsListener = listener
    }

    /** Connect [identifier] with CBConnectPeripheralOptionRequiresANCS (the right arm relays iPhone notifications). */
    fun setRequiresAncs(identifier: String, required: Boolean) {
        val key = identifier.uppercase()
        cond.withLock { peers[key]?.requiresAncs = required }
        pendingAncs[key] = required
    }

    private val pendingAncs = HashMap<String, Boolean>()

    /** Whether the OS granted ANCS for the peripheral (false when unknown or disconnected). */
    fun isAncsAuthorized(identifier: String): Boolean =
        cond.withLock { peers[identifier.uppercase()]?.peripheral?.ancsAuthorized ?: false }

    // ----- readiness and scanning -----------------------------------------------------------

    /** Current CBManagerState raw value (0 until the central reports). */
    fun bluetoothState(): Int = bluetoothState.toInt()

    fun authorization(): Int = CBManager.authorization.toInt()

    /**
     * Creates the central (which triggers the permission prompt on first use) and waits for
     * it to power on. Returns null when ready or a user-facing message (the same texts the
     * TypeScript transport used).
     */
    fun waitForPoweredOn(timeoutMs: Int = READY_TIMEOUT_MS): String? {
        ensureCentral()
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        cond.lock()
        try {
            while (true) {
                when (bluetoothState) {
                    CBManagerStatePoweredOn -> return null
                    CBManagerStateUnsupported -> return "Bluetooth is unavailable on this device. Use the physical iPhone."
                    CBManagerStateUnauthorized -> return "Allow Faceclaw to use Bluetooth in iPhone Settings."
                    CBManagerStatePoweredOff -> return "Turn on Bluetooth, then try again."
                }
                val left = deadline - platform.elapsedRealtimeMs()
                if (left <= 0) return "Waiting for Bluetooth permission timed out. Try again after allowing Bluetooth."
                cond.awaitMs(left)
            }
        } finally {
            cond.unlock()
        }
    }

    private fun ensureCentral() {
        if (central != null) {
            // Re-report the current state so a fresh listener learns it.
            val listener = scanListener
            if (listener != null) {
                val state = bluetoothState.toInt()
                val authorization = authorization()
                dispatch_async(dispatch_get_main_queue()) { listener.onBluetoothState(state, authorization) }
            }
            return
        }
        central = CBCentralManager(delegate = delegate, queue = queue)
    }

    /**
     * Registers the scan/state listener and creates the central if needed, so a listener that
     * only waits for readiness (no scan) still receives the state report; an existing central's
     * current state is re-reported to the new listener on the main queue.
     */
    fun setScanListener(listener: IosBleScanListener?) {
        scanListener = listener
        if (listener != null && !closed) ensureCentral()
    }

    /** Starts (or keeps) scanning for all peripherals with duplicates; events reach the scan listener on main. */
    fun startScan() {
        scanRequested = true
        ensureCentral()
        dispatch_sync(queue) {
            val manager = central ?: return@dispatch_sync
            if (manager.state == CBManagerStatePoweredOn) beginScan(manager)
        }
    }

    fun stopScan() {
        scanRequested = false
        dispatch_sync(queue) { central?.stopScan() }
    }

    private fun beginScan(manager: CBCentralManager) {
        manager.scanForPeripheralsWithServices(null, mapOf(CBCentralManagerScanOptionAllowDuplicatesKey to true))
    }

    /** Known peripheral identifiers from this process's scans/retrievals (uppercase). */
    fun knownIdentifiers(): List<String> = cond.withLock { peers.keys.toList() }

    // ----- SessionLink / StockLink ----------------------------------------------------------

    override fun connect(address: String, timeoutMs: Int): Boolean {
        val identifier = address.uppercase()
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        val ready = waitForPoweredOn(minOf(timeoutMs, READY_TIMEOUT_MS))
        if (ready != null) {
            log("connect $identifier: $ready")
            return false
        }
        val peer = findOrDiscover(identifier, deadline) ?: run {
            log("connect $identifier: peripheral not found")
            return false
        }
        val requiresAncs = cond.withLock {
            if (peer.connected || peer.connectPending) {
                log("connect $identifier: already connecting or connected")
                return peer.connected
            }
            peer.characteristics.clear()
            peer.failure = null
            peer.connectPending = true
            peer.reportedConnected = false
            peer.requiresAncs || (pendingAncs[identifier] ?: false)
        }
        dispatch_sync(queue) {
            val manager = central ?: return@dispatch_sync
            manager.connectPeripheral(
                peer.peripheral,
                if (requiresAncs) mapOf(CBConnectPeripheralOptionRequiresANCS to true) else null,
            )
        }
        val connected = cond.withLock {
            while (peer.connectPending) {
                val left = deadline - platform.elapsedRealtimeMs()
                if (left <= 0) break
                cond.awaitMs(left)
            }
            val ok = peer.connected
            if (!ok) peer.connectPending = false
            ok
        }
        if (!connected) {
            log("connect $identifier failed: " + (cond.withLock { peer.failure } ?: "timeout"))
            dispatch_sync(queue) { central?.cancelPeripheralConnection(peer.peripheral) }
        }
        return connected
    }

    private fun findOrDiscover(identifier: String, deadline: Long): Peer? {
        cond.withLock { peers[identifier] }?.let { return it }
        var retrieved: CBPeripheral? = null
        dispatch_sync(queue) {
            val manager = central ?: return@dispatch_sync
            val uuid = NSUUID(uUIDString = identifier) ?: return@dispatch_sync
            retrieved = manager.retrievePeripheralsWithIdentifiers(listOf(uuid)).firstOrNull() as? CBPeripheral
        }
        retrieved?.let { return remember(it) }
        // Not known to the system: scan until the identifier shows up.
        val wasScanning = scanRequested
        startScan()
        try {
            cond.lock()
            try {
                while (true) {
                    peers[identifier]?.let { return it }
                    val left = deadline - platform.elapsedRealtimeMs()
                    if (left <= 0) return null
                    cond.awaitMs(left)
                }
            } finally {
                cond.unlock()
            }
        } finally {
            if (!wasScanning) stopScan()
        }
    }

    override fun requestHighPriority(address: String) {}

    override fun requestMtu(address: String, mtu: Int, timeoutMs: Int): Boolean = true

    override fun prepareLink(address: String, desiredMtu: Int, timeoutMs: Int) {}

    override fun negotiatedMtu(address: String): Int {
        val peer = cond.withLock { peers[address.uppercase()] } ?: return DEFAULT_ATT_MTU
        // CoreBluetooth reports the ATT payload; Android reports the ATT MTU (payload + 3).
        val payload = peer.peripheral.maximumWriteValueLengthForType(CBCharacteristicWriteWithoutResponse).toInt()
        return (payload + 3).coerceIn(DEFAULT_ATT_MTU, MAX_ATT_MTU)
    }

    override fun discoverServices(address: String, timeoutMs: Int): Boolean {
        val peer = connectedPeer(address) ?: return false
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        cond.withLock {
            peer.discoverPending = true
            peer.pendingServices = 0
            peer.characteristics.clear()
        }
        dispatch_sync(queue) { peer.peripheral.discoverServices(null) }
        return cond.withLock {
            while (peer.discoverPending && peer.connected) {
                val left = deadline - platform.elapsedRealtimeMs()
                if (left <= 0) break
                cond.awaitMs(left)
            }
            !peer.discoverPending && peer.connected && peer.characteristics.isNotEmpty()
        }
    }

    override fun enableNotifications(address: String, characteristicUuid: String, timeoutMs: Int): Boolean =
        enableNotifications(address, characteristicUuid, true, timeoutMs)

    override fun enableNotifications(address: String, characteristicUuid: String, enable: Boolean, timeoutMs: Int): Boolean {
        val peer = connectedPeer(address) ?: return false
        val key = characteristicUuid.lowercase()
        val characteristic = cond.withLock { peer.characteristics[key] } ?: run {
            log("notifications $key: characteristic unavailable")
            return false
        }
        val notifiable = (characteristic.properties and (CBCharacteristicPropertyNotify or CBCharacteristicPropertyIndicate)) != 0uL
        if (!notifiable) {
            log("notifications $key: not notifiable")
            return false
        }
        if (characteristic.isNotifying == enable) return true
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        cond.withLock {
            peer.notifyPending = key
            peer.notifyResult = null
        }
        dispatch_sync(queue) { peer.peripheral.setNotifyValue(enable, characteristic) }
        return cond.withLock {
            while (peer.notifyPending == key && peer.connected) {
                val left = deadline - platform.elapsedRealtimeMs()
                if (left <= 0) break
                cond.awaitMs(left)
            }
            val result = peer.notifyResult == true && peer.connected
            if (peer.notifyPending == key) peer.notifyPending = null
            result || (!enable && peer.connected)
        }
    }

    override fun writeFrames(
        address: String,
        characteristicUuid: String,
        frames: List<ByteArray>,
        mode: GattWriteMode,
        timeoutMs: Int,
    ): Boolean {
        val peer = connectedPeer(address) ?: return false
        val key = characteristicUuid.lowercase()
        val characteristic = cond.withLock { peer.characteristics[key] } ?: run {
            log("write $key: characteristic unavailable")
            return false
        }
        val writable = (characteristic.properties and (CBCharacteristicPropertyWrite or CBCharacteristicPropertyWriteWithoutResponse)) != 0uL
        if (!writable) return false
        val withoutResponseSupported = (characteristic.properties and CBCharacteristicPropertyWriteWithoutResponse) != 0uL
        val type: CBCharacteristicWriteType =
            if (mode == GattWriteMode.WITHOUT_RESPONSE && withoutResponseSupported) CBCharacteristicWriteWithoutResponse
            else CBCharacteristicWriteWithResponse
        val limit = peer.peripheral.maximumWriteValueLengthForType(type).toInt()
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        for (frame in frames) {
            if (frame.size > limit) {
                log("write $key: ${frame.size} bytes exceeds the ${limit}-byte limit")
                return false
            }
            val data = frame.data()
            if (type == CBCharacteristicWriteWithResponse) {
                cond.withLock {
                    peer.writePending = true
                    peer.writeError = null
                }
                dispatch_sync(queue) { peer.peripheral.writeValue(data, characteristic, type) }
                val ok = cond.withLock {
                    while (peer.writePending && peer.connected) {
                        val left = deadline - platform.elapsedRealtimeMs()
                        if (left <= 0) break
                        cond.awaitMs(left)
                    }
                    val done = !peer.writePending && peer.writeError == null && peer.connected
                    peer.writePending = false
                    done
                }
                if (!ok) {
                    log("write $key failed: " + (cond.withLock { peer.writeError } ?: "timeout"))
                    return false
                }
                IosBleTraffic.recordWrite(frame.size)
            } else {
                while (true) {
                    var sent = false
                    var connected = true
                    dispatch_sync(queue) {
                        if (peer.peripheral.state != CBPeripheralStateConnected) {
                            connected = false
                        } else if (peer.peripheral.canSendWriteWithoutResponse) {
                            peer.peripheral.writeValue(data, characteristic, type)
                            sent = true
                        }
                    }
                    if (!connected) return false
                    if (sent) {
                        IosBleTraffic.recordWrite(frame.size)
                        break
                    }
                    // Pace on the controller's buffer: wait for peripheralIsReadyToSendWriteWithoutResponse.
                    val ready = cond.withLock {
                        peer.readyForWriteWithoutResponse = false
                        while (!peer.readyForWriteWithoutResponse && peer.connected) {
                            val left = deadline - platform.elapsedRealtimeMs()
                            if (left <= 0) break
                            cond.awaitMs(minOf(left, 50))
                            // canSendWriteWithoutResponse may flip without a callback; re-check.
                            if (peer.peripheral.canSendWriteWithoutResponse) break
                        }
                        peer.connected && (peer.readyForWriteWithoutResponse || peer.peripheral.canSendWriteWithoutResponse)
                    }
                    if (!ready) {
                        if (platform.elapsedRealtimeMs() >= deadline) {
                            log("write $key: timed out waiting for the write buffer")
                            return false
                        }
                        if (!cond.withLock { peer.connected }) return false
                    }
                }
            }
        }
        return true
    }

    override fun isConnected(address: String): Boolean =
        cond.withLock { peers[address.uppercase()]?.connected ?: false }

    override fun bondState(address: String): BondState = BondState.UNKNOWN

    override fun isBonded(address: String): Boolean = true

    override fun prepareBenchmarkLink(address: String, mode: Int) {}

    override fun recordDisplayFrameSent() {
        IosBleTraffic.recordDisplayFrame()
    }

    override fun disconnect(address: String) {
        val peer = cond.withLock { peers[address.uppercase()] } ?: return
        dispatch_sync(queue) {
            if (peer.peripheral.state != CBPeripheralStateDisconnected) central?.cancelPeripheralConnection(peer.peripheral)
        }
        failPeer(peer, "Disconnected", notifyListeners = false)
    }

    override fun close() {
        closed = true
        scanRequested = false
        val all = cond.withLock { peers.values.toList() }
        dispatch_sync(queue) {
            central?.stopScan()
            for (peer in all) if (peer.peripheral.state != CBPeripheralStateDisconnected) central?.cancelPeripheralConnection(peer.peripheral)
        }
        for (peer in all) failPeer(peer, "Closed", notifyListeners = false)
    }

    // ----- internals ------------------------------------------------------------------

    private fun connectedPeer(address: String): Peer? {
        val peer = cond.withLock { peers[address.uppercase()]?.takeIf { it.connected } }
        if (peer == null) log("$address is not connected")
        return peer
    }

    private fun remember(peripheral: CBPeripheral): Peer {
        val identifier = peripheral.identifier.UUIDString.uppercase()
        return cond.withLock {
            peers.getOrPut(identifier) {
                peripheral.delegate = delegate
                Peer(peripheral).also { it.requiresAncs = pendingAncs[identifier] ?: false }
            }
        }
    }

    /** Marks the peer disconnected, wakes every waiter and (optionally) tells the listeners. */
    private fun failPeer(peer: Peer, reason: String, notifyListeners: Boolean) {
        val wasReported = cond.withLock {
            val reported = peer.reportedConnected
            peer.failure = reason
            peer.connectPending = false
            peer.connected = false
            peer.reportedConnected = false
            peer.discoverPending = false
            peer.notifyPending = null
            peer.writePending = false
            peer.readyForWriteWithoutResponse = false
            peer.characteristics.clear()
            cond.signalAll()
            reported
        }
        if (notifyListeners && wasReported) emitConnectionState(peer.identifier, false)
    }

    private fun emitConnectionState(identifier: String, connected: Boolean) {
        sessionListener?.onConnectionStateChange(identifier, connected)
        stockListener?.onConnectionStateChange(identifier, connected)
    }

    private fun log(message: String) = PlatformLog.i(TAG, message)

    // ----- delegate callbacks (BLE queue) ----------------------------------------------------

    private fun onStateUpdated(manager: CBCentralManager) {
        val state = manager.state
        bluetoothState = state
        cond.withLock { cond.signalAll() }
        val listener = scanListener
        if (listener != null) {
            val authorization = authorization()
            dispatch_async(dispatch_get_main_queue()) { listener.onBluetoothState(state.toInt(), authorization) }
        }
        if (state != CBManagerStatePoweredOn) {
            val all = cond.withLock { peers.values.toList() }
            for (peer in all) failPeer(peer, "Bluetooth is unavailable", notifyListeners = true)
        } else if (scanRequested) {
            beginScan(manager)
        }
    }

    private fun onDiscovered(peripheral: CBPeripheral, advertisementData: Map<Any?, *>, rssi: NSNumber) {
        val peer = remember(peripheral)
        cond.withLock { cond.signalAll() } // findOrDiscover may be waiting for this identifier
        val listener = scanListener ?: return
        val manufacturer = (advertisementData[CBAdvertisementDataManufacturerDataKey] as? NSData)?.byteArray()
        val advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        val connectable = (advertisementData[CBAdvertisementDataIsConnectable] as? NSNumber)?.boolValue ?: true
        val merged = cond.withLock {
            val previous = advertisements.remove(peer.identifier)
            val name = advertisedName ?: peripheral.name ?: previous?.name ?: ""
            val hex = if (manufacturer != null) BinaryEncoding.bytesToHex(manufacturer) else previous?.manufacturerDataHex ?: ""
            if (advertisements.size >= ADVERTISEMENT_CACHE) advertisements.remove(advertisements.keys.first())
            Advertisement(name, hex).also { advertisements[peer.identifier] = it }
        }
        val identifier = peer.identifier
        val level = rssi.intValue
        dispatch_async(dispatch_get_main_queue()) {
            listener.onAdvertisement(identifier, merged.name, merged.manufacturerDataHex, level, connectable)
        }
    }

    private fun onConnected(peripheral: CBPeripheral) {
        val peer = remember(peripheral)
        cond.withLock {
            peer.connected = true
            peer.connectPending = false
            peer.failure = null
            peer.reportedConnected = true
            cond.signalAll()
        }
        emitConnectionState(peer.identifier, true)
    }

    private fun onDisconnected(peripheral: CBPeripheral, error: NSError?) {
        val peer = remember(peripheral)
        failPeer(peer, error?.localizedDescription ?: "Disconnected", notifyListeners = true)
    }

    private fun onServicesDiscovered(peripheral: CBPeripheral, error: NSError?) {
        val peer = remember(peripheral)
        val services = peripheral.services?.mapNotNull { it as? CBService } ?: emptyList()
        if (error != null || services.isEmpty()) {
            cond.withLock {
                peer.discoverPending = false
                cond.signalAll()
            }
            return
        }
        cond.withLock { peer.pendingServices = services.size }
        for (service in services) peripheral.discoverCharacteristics(null, service)
    }

    private fun onCharacteristicsDiscovered(peripheral: CBPeripheral, service: CBService, error: NSError?) {
        val peer = remember(peripheral)
        cond.withLock {
            if (error == null) {
                for (item in service.characteristics ?: emptyList<Any?>()) {
                    val characteristic = item as? CBCharacteristic ?: continue
                    peer.characteristics[characteristic.UUID.UUIDString.lowercase()] = characteristic
                }
            }
            peer.pendingServices--
            if (peer.pendingServices <= 0) peer.discoverPending = false
            cond.signalAll()
        }
    }

    private fun onNotificationState(peripheral: CBPeripheral, characteristic: CBCharacteristic, error: NSError?) {
        val peer = remember(peripheral)
        val key = characteristic.UUID.UUIDString.lowercase()
        cond.withLock {
            if (peer.notifyPending == key) {
                peer.notifyResult = error == null && characteristic.isNotifying
                peer.notifyPending = null
            }
            cond.signalAll()
        }
    }

    private fun onValue(peripheral: CBPeripheral, characteristic: CBCharacteristic, error: NSError?) {
        if (error != null) {
            log("notification error: " + error.localizedDescription)
            return
        }
        val data = characteristic.value?.byteArray() ?: return
        val identifier = peripheral.identifier.UUIDString.uppercase()
        val uuid = characteristic.UUID.UUIDString.lowercase()
        IosBleTraffic.recordRead(data.size)
        sessionListener?.onNotification(identifier, uuid, data)
        stockListener?.onNotification(identifier, uuid, data)
    }

    private fun onWrote(peripheral: CBPeripheral, error: NSError?) {
        val peer = remember(peripheral)
        cond.withLock {
            peer.writeError = error?.localizedDescription
            peer.writePending = false
            cond.signalAll()
        }
    }

    private fun onReadyForWriteWithoutResponse(peripheral: CBPeripheral) {
        val peer = remember(peripheral)
        cond.withLock {
            peer.readyForWriteWithoutResponse = true
            cond.signalAll()
        }
    }

    private fun onAncsAuthorization(peripheral: CBPeripheral) {
        val identifier = peripheral.identifier.UUIDString.uppercase()
        ancsListener?.onAncsAuthorization(identifier, peripheral.ancsAuthorized)
    }

    private class Delegate(private val owner: IosBleCentral) : NSObject(), CBCentralManagerDelegateProtocol, CBPeripheralDelegateProtocol {
        override fun centralManagerDidUpdateState(central: CBCentralManager) = owner.onStateUpdated(central)

        override fun centralManager(central: CBCentralManager, didDiscoverPeripheral: CBPeripheral, advertisementData: Map<Any?, *>, RSSI: NSNumber) =
            owner.onDiscovered(didDiscoverPeripheral, advertisementData, RSSI)

        @ObjCSignatureOverride
        override fun centralManager(central: CBCentralManager, didConnectPeripheral: CBPeripheral) = owner.onConnected(didConnectPeripheral)

        @ObjCSignatureOverride
        override fun centralManager(central: CBCentralManager, didFailToConnectPeripheral: CBPeripheral, error: NSError?) =
            owner.onDisconnected(didFailToConnectPeripheral, error)

        @ObjCSignatureOverride
        override fun centralManager(central: CBCentralManager, didDisconnectPeripheral: CBPeripheral, error: NSError?) =
            owner.onDisconnected(didDisconnectPeripheral, error)

        @ObjCSignatureOverride
        override fun centralManager(central: CBCentralManager, didUpdateANCSAuthorizationForPeripheral: CBPeripheral) =
            owner.onAncsAuthorization(didUpdateANCSAuthorizationForPeripheral)

        override fun peripheral(peripheral: CBPeripheral, didDiscoverServices: NSError?) = owner.onServicesDiscovered(peripheral, didDiscoverServices)

        @ObjCSignatureOverride
        override fun peripheral(peripheral: CBPeripheral, didDiscoverCharacteristicsForService: CBService, error: NSError?) =
            owner.onCharacteristicsDiscovered(peripheral, didDiscoverCharacteristicsForService, error)

        @ObjCSignatureOverride
        override fun peripheral(peripheral: CBPeripheral, didUpdateNotificationStateForCharacteristic: CBCharacteristic, error: NSError?) =
            owner.onNotificationState(peripheral, didUpdateNotificationStateForCharacteristic, error)

        @ObjCSignatureOverride
        override fun peripheral(peripheral: CBPeripheral, didUpdateValueForCharacteristic: CBCharacteristic, error: NSError?) =
            owner.onValue(peripheral, didUpdateValueForCharacteristic, error)

        @ObjCSignatureOverride
        override fun peripheral(peripheral: CBPeripheral, didWriteValueForCharacteristic: CBCharacteristic, error: NSError?) =
            owner.onWrote(peripheral, error)

        override fun peripheralIsReadyToSendWriteWithoutResponse(peripheral: CBPeripheral) = owner.onReadyForWriteWithoutResponse(peripheral)
    }
}

/** Process-wide BLE traffic counters (the TypeScript ios-ble-traffic counters' successor). */
object IosBleTraffic {
    private val lock = IosProtocolPlatform.createLock()
    private var bytesWritten = 0L
    private var bytesRead = 0L
    private var displayFrames = 0L

    fun recordWrite(bytes: Int) = lock.withLock { bytesWritten += bytes }

    fun recordRead(bytes: Int) = lock.withLock { bytesRead += bytes }

    fun recordDisplayFrame() = lock.withLock { displayFrames++ }

    /** [bytesWritten, bytesRead, displayFrames] and resets the counters. */
    fun sample(): LongArray = lock.withLock {
        val out = longArrayOf(bytesWritten, bytesRead, displayFrames)
        bytesWritten = 0
        bytesRead = 0
        displayFrames = 0
        out
    }
}
