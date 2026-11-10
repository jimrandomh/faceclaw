// Transport adapted from tetramo-labs/glassly (MIT): bluetooth-sdk controllers/neuralband/NeuralBand.kt,
// itself adapted from beyondlevi/rokid-lumen (MIT, Copyright (c) 2026 beyondlevi): band/BandLink.kt and
// callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Sources/Kinesis/BandConnection.swift.
// The protocol lives in native/kotlin/shared/.../neuralband/.
package com.faceclaw.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothSocket
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.faceclaw.app.neuralband.BAND_SCHEME_GUESS_COUNT
import com.faceclaw.app.neuralband.BandEvent
import com.faceclaw.app.neuralband.BandGesture
import com.faceclaw.app.neuralband.BandHand
import com.faceclaw.app.neuralband.BandIdentityMismatchError
import com.faceclaw.app.neuralband.BandLog
import com.faceclaw.app.neuralband.BandProtocolError
import com.faceclaw.app.neuralband.BandSession
import com.faceclaw.app.neuralband.CeremonyHTTPRequest
import com.faceclaw.app.neuralband.DialRouter
import com.faceclaw.app.neuralband.GestureRouter
import com.faceclaw.app.neuralband.MotionStreams
import com.faceclaw.app.neuralband.NeuralBandPinch
import com.faceclaw.app.neuralband.OwnershipCeremony
import com.faceclaw.app.neuralband.RecognizedGesture
import com.faceclaw.app.neuralband.TapResolver
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.concurrent.thread
import org.json.JSONObject

/** The link to the band broke or stayed silent: a closed channel, a startup timeout. During a claim these are retried. */
class BandLinkError(message: String) : Exception(message)

/**
 * The Meta Neural Band as a phone-side controller: read the input-channel PSM over GATT, open an
 * L2CAP channel on it and run the band session; gestures go to TypeScript (app/g2/neural-band.ts),
 * which turns them into the watch-scheme inputs the shell already understands.
 *
 * One band is remembered (address and name). A band with no stored identity is claimed first: the
 * ownership ceremony, whose two HTTP exchanges use the Meta account session from
 * FaceclawMetaSignInActivity. After that the stored identity is enough (the Meta session is
 * deleted), and a bonded band reconnects with `autoConnect`.
 *
 * Threads: GATT callbacks on the binder thread, the L2CAP reader and a ticker per attempt, the
 * Meta exchanges on their own. Session state is guarded by [lock]; every attempt bumps
 * [generation] so stale threads and callbacks drop out. Events reach the listener's Looper.
 */
@SuppressLint("MissingPermission")
class FaceclawNeuralBand private constructor(appContext: Context) {
    private val context: Context = appContext.applicationContext
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    /** The pairing scan's timeout; apart from [main], whose messages every teardown clears. */
    private val scanTimer = Handler(Looper.getMainLooper())
    private val lock = Any()
    private val identities = FaceclawBandIdentityStore(context)
    private val metaSessions = MetaSessionStore(context)

    // Looked up on every use: an adapter held across a Bluetooth restart can keep reporting "off".
    private val adapter get() = context.getSystemService(BluetoothManager::class.java)?.adapter

    private var listener: FaceclawNeuralBandListener? = null
    private var listenerHandler: Handler? = null

    private var gatt: BluetoothGatt? = null
    @Volatile private var batteryCharacteristic: BluetoothGattCharacteristic? = null
    @Volatile private var socket: BluetoothSocket? = null
    private var session: BandSession? = null
    @Volatile private var output: OutputStream? = null
    private val pendingWrites = ConcurrentLinkedQueue<ByteArray>()
    @Volatile private var generation = 0
    @Volatile private var wanted = false
    @Volatile private var claiming = false
    @Volatile private var stopping = false
    @Volatile private var psmRead = false
    @Volatile private var lastInput = 0L
    private var failures = 0
    private var connectScanning = false
    private var pairingScan = false
    private val discovered = HashMap<String, BluetoothDevice>()
    /**
     * The band rejected (or seemed to reject) the stored identity: the next attempt claims it
     * again when there is a Meta session to claim with.
     */
    @Volatile private var identityRejected = false

    /**
     * The bonded band was waited for and never connected. A factory reset gives the band a new
     * identity key, so its old bond never resolves: the next attempt scans by name.
     */
    private var bondedUnreachable = false

    /** The ceremony stage the band last reached, null until it answers the identity read. */
    private var claimStage: String? = null
    private var claimRetries = 0
    private var claimStarted = 0.0
    private var guessAttempts = 0

    private var gestures = GestureRouter()
    private val taps = TapResolver()
    private val pinches = NeuralBandPinch()
    private var dial = DialRouter()
    private var dialEngaged = false
    @Volatile private var motion = MotionStreams.NONE
    @Volatile private var gestureHaptics = true

    private var nextBatteryStatus = 0.0
    private var lastSensorRead = 0.0
    private var lastStatusQuery = 0.0

    // Status, read by TypeScript through getStatusJson and pushed as "status" events.
    @Volatile private var state = "idle"
    @Volatile private var message = ""
    @Volatile private var sessionExpired = false
    @Volatile private var battery = -1
    @Volatile private var charging: Boolean? = null
    @Volatile private var hand: BandHand? = null
    @Volatile private var firmware = ""

    private val log = object : BandLog {
        override fun info(message: String) { Log.i(TAG, message) }
        override fun error(message: String) { Log.w(TAG, message) }
    }

    // MARK: - Remembered band

    /** The band's Bluetooth address when it last connected; its stored identity is keyed by it. */
    private var storedAddress: String?
        get() = prefs.getString(KEY_ADDRESS, null)?.takeIf { it.isNotEmpty() }
        set(value) { prefs.edit().apply { if (value == null) remove(KEY_ADDRESS) else putString(KEY_ADDRESS, value) }.apply() }

    private var storedName: String?
        get() = prefs.getString(KEY_NAME, null)?.takeIf { it.isNotEmpty() }
        set(value) { prefs.edit().apply { if (value == null) remove(KEY_NAME) else putString(KEY_NAME, value) }.apply() }

    private var schemeGuess: Int
        get() = prefs.getInt(KEY_SCHEME, 0)
        set(value) { prefs.edit().putInt(KEY_SCHEME, value).apply() }

    // MARK: - TypeScript API

    /** Whether this phone can talk to the band at all (it needs LE L2CAP channels, Android 10+). */
    fun isSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    /** Register the JS listener; events are delivered on the calling thread's Looper. */
    fun setListener(newListener: FaceclawNeuralBandListener?) {
        val looper = Looper.myLooper()
        synchronized(lock) {
            listener = newListener
            listenerHandler = if (newListener != null && looper != null) Handler(looper) else null
        }
        sendStatus()
    }

    fun getStatusJson(): String = statusJson().toString()

    fun hasMetaSession(): Boolean = metaSessions.hasSavedSession()

    /** Forget the Meta account session. A band already claimed keeps working without it. */
    fun signOutMeta() {
        metaSessions.deleteSession()
        sendStatus()
    }

    /** Open the Meta sign-in. Needs a foreground activity (Android blocks background starts). */
    fun startMetaSignIn(activity: Activity) {
        activity.startActivity(Intent(activity, FaceclawMetaSignInActivity::class.java))
    }

    /** Scan for bands in pairing mode; each one found is reported as a "discovered" event. */
    fun startScan() {
        if (!isSupported()) return
        main.post {
            pairingScan = true
            discovered.clear()
            startLeScan()
            scanTimer.removeCallbacksAndMessages(null)
            scanTimer.postDelayed({ stopPairingScan() }, PAIRING_SCAN_MS)
        }
    }

    fun stopScan() = main.post { stopPairingScan() }

    /**
     * Remember the band at [address] and connect to it, claiming it when it has no stored
     * identity. A different band remembered before is forgotten (its identity too); the same
     * band under a new address (the name says) keeps its identity.
     */
    fun pair(address: String, name: String) {
        main.post {
            stopPairingScan()
            val previous = storedAddress
            if (previous != null && !isRememberedBand(address, name)) forgetBand(previous)
            // No graceful stop: a stop waits for the band's answer with the link still up, and
            // the new connection can't start until it is gone.
            wanted = false
            teardown()
            storedAddress = address
            storedName = name.ifEmpty { null }
            identityRejected = false
            schemeGuess = 0
            startWanted()
        }
    }

    /** Connect to the remembered band (no-op without one, or when already connecting). */
    fun connect() {
        if (!isSupported()) return
        main.post {
            if (storedAddress == null || wanted) return@post
            startWanted()
        }
    }

    /** Drop the link and stop reconnecting until [connect] or [pair]. */
    fun disconnect() = main.post { disconnectNow() }

    /** Disconnect and forget the band: its address, name, identity, bond and any Meta session. */
    fun forget() {
        main.post {
            disconnectNow()
            storedAddress?.let { forgetBand(it) }
            storedAddress = null
            storedName = null
            metaSessions.deleteSession()
            setState("idle", "")
        }
    }

    /** Stream gyro so an index pinch-and-twist works as a dial. Costs band and phone battery. */
    fun setTwistScroll(enabled: Boolean) {
        motion = if (enabled) MotionStreams(gyro = true, orientation = false) else MotionStreams.NONE
        send { session -> session.setMotionStreams(motion, now()) }
    }

    /** The band's own vibration on recognised gestures. */
    fun setGestureHaptics(enabled: Boolean) {
        gestureHaptics = enabled
        send { session ->
            session.setGestureHaptics(enabled)
            session.flushGestureHaptics(now())
        }
    }

    /** Which wrist the band is worn on; the band orients its swipes by it. */
    fun setHand(left: Boolean) {
        synchronized(lock) {
            val session = session
            if (session == null || stopping) throw BandProtocolError("Connect the band before choosing a wrist.")
            queue(session.setHandedness(if (left) BandHand.LEFT else BandHand.RIGHT, now()))
        }
        drain()
    }

    fun requestBattery() {
        send { session -> if (session.streamsEnabled) session.queryBatteryStatus(now()) else null }
    }

    // MARK: - Status and events

    private fun statusJson(): JSONObject = JSONObject()
        .put("type", "status")
        .put("supported", isSupported())
        .put("state", state)
        .put("message", message)
        .put("sessionExpired", sessionExpired)
        .put("paired", storedAddress != null)
        .put("address", storedAddress ?: "")
        .put("name", storedName ?: "")
        .put("claimed", storedAddress != null && identities.load(IDENTITY_ID) != null)
        .put("metaSignedIn", metaSessions.hasSavedSession())
        .put("battery", battery)
        .put("charging", charging ?: JSONObject.NULL)
        .put("hand", hand?.rawValue ?: JSONObject.NULL)
        .put("firmware", firmware)
        .put("scanning", pairingScan)

    private fun emit(json: JSONObject) {
        val (target, handler) = synchronized(lock) { listener to listenerHandler }
        if (target == null || handler == null) return
        val text = json.toString()
        handler.post {
            try {
                target.onEvent(text)
            } catch (e: Exception) {
                Log.w(TAG, "listener failed: ${e.message}")
            }
        }
    }

    private fun sendStatus() = emit(statusJson())

    private fun setState(state: String, message: String?, sessionExpired: Boolean = false) {
        this.state = state
        if (message != null) this.message = message
        this.sessionExpired = sessionExpired
        sendStatus()
    }

    /** A line for the phone UI's log as well as logcat. Never band keys or Meta tokens. */
    private fun logLine(text: String) {
        Log.i(TAG, text)
        emit(JSONObject().put("type", "log").put("text", text))
    }

    private fun emitGesture(gesture: String, finger: Int? = null) {
        val json = JSONObject().put("type", "gesture").put("gesture", gesture)
        if (finger != null) json.put("finger", finger)
        emit(json)
    }

    internal fun onMetaSignInEnded() {
        sessionExpired = false
        sendStatus()
        // A claim that stopped for want of a session can go ahead now.
        if (metaSessions.hasSavedSession() && storedAddress != null && !wanted) connect()
    }

    // MARK: - Writes

    private fun queue(bytes: ByteArray) {
        if (bytes.isNotEmpty()) pendingWrites.add(bytes)
    }

    private fun drain() {
        val output = output ?: run { pendingWrites.clear(); return }
        try {
            synchronized(output) {
                while (true) output.write(pendingWrites.poll() ?: return)
            }
        } catch (e: IOException) {
            // The reader sees the closed channel and handles the retry.
            Log.w(TAG, "write failed: ${e.message}")
        }
    }

    /** Runs [block] on the session under the lock and writes what it returns. */
    private fun send(block: (BandSession) -> ByteArray?) {
        synchronized(lock) {
            val session = session ?: return
            if (stopping) return
            val bytes = try { block(session) } catch (e: BandProtocolError) { Log.w(TAG, e.message); null } ?: return
            queue(bytes)
        }
        drain()
    }

    // MARK: - Connection

    private fun hasPermissions(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT).all {
            context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun startWanted() {
        wanted = true
        failures = 0
        bondedUnreachable = false
        claimRetries = 0
        connectNow()
    }

    private fun disconnectNow() {
        wanted = false
        synchronized(lock) {
            for ((_, finger) in pinches.releaseAll()) emitGesture("release", finger)
            taps.reset()
        }
        main.removeCallbacksAndMessages(null)
        stop()
        setState(if (storedAddress == null) "idle" else "disconnected", "")
    }

    private fun connectNow() {
        // Connected or connecting already: a second request changes nothing.
        if (!wanted || gatt != null) return
        val address = storedAddress ?: return
        val adapter = adapter
        if (adapter == null || !adapter.isEnabled || !hasPermissions()) {
            setState("connecting", "Bluetooth is off or not permitted.")
            retry(5000)
            return
        }
        setState(if (identities.load(IDENTITY_ID) == null) "claiming" else "connecting", null)
        // A bonded band reconnects without pairing mode: the stack waits for it.
        val bonded = if (bondedUnreachable) null else bondedDevice(address)
        if (bonded != null) {
            Log.i(TAG, "waiting for ${bonded.name ?: bonded.address}")
            stopConnectScan()
            val attempt = generation
            gatt = bonded.connectGatt(context, true, gattCallback, BluetoothDevice.TRANSPORT_LE)
            main.postDelayed({
                if (attempt == generation && session == null) {
                    Log.i(TAG, "the remembered band didn't connect; scanning for it")
                    bondedUnreachable = true
                    retry(1000)
                }
            }, BONDED_CONNECT_TIMEOUT_MS)
        } else {
            Log.i(TAG, "scanning for ${storedName ?: address}")
            connectScanning = true
            startLeScan()
        }
    }

    private var leScanning = false

    private fun startLeScan() {
        val scanner = adapter?.takeIf { it.isEnabled }?.bluetoothLeScanner
        if (scanner == null || !hasPermissions()) {
            Log.w(TAG, "cannot scan: Bluetooth is off or not permitted")
            if (pairingScan) setState(state, "Bluetooth is off or not permitted.")
            if (wanted) retry(5000)
            return
        }
        if (!leScanning) {
            leScanning = true
            scanner.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scan)
        }
        sendStatus()
    }

    private fun stopLeScanIfIdle() {
        if (!leScanning || pairingScan || connectScanning) return
        leScanning = false
        runCatching { adapter?.bluetoothLeScanner?.stopScan(scan) }
    }

    private fun stopPairingScan() {
        scanTimer.removeCallbacksAndMessages(null)
        if (!pairingScan) return
        pairingScan = false
        stopLeScanIfIdle()
        sendStatus()
    }

    private fun stopConnectScan() {
        connectScanning = false
        stopLeScanIfIdle()
    }

    private val scan = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val name = result.scanRecord?.deviceName ?: result.device.name ?: return
            if (!name.lowercase().startsWith(NAME_PREFIX)) return
            if (pairingScan && discovered.put(result.device.address, result.device) == null) {
                Log.i(TAG, "discovered $name (RSSI ${result.rssi})")
                emit(JSONObject().put("type", "discovered").put("name", name).put("address", result.device.address).put("rssi", result.rssi))
            }
            if (!connectScanning || !wanted || gatt != null) return
            val stored = storedAddress ?: return
            if (!isRememberedBand(result.device.address, name)) return
            stopConnectScan()
            if (!stored.equals(result.device.address, ignoreCase = true)) {
                // The band advertises from a rotating private address until it is bonded, and
                // under its identity address after; the name stays. A factory-reset band keeps
                // its name too, but then rejects the stored identity and is claimed again.
                Log.i(TAG, "$name moved address")
                storedAddress = result.device.address
            }
            Log.i(TAG, "found $name; connecting")
            gatt = result.device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        }

        override fun onScanFailed(errorCode: Int) {
            Log.w(TAG, "scan failed ($errorCode)")
            leScanning = false
            if (wanted) main.post { retry(5000) }
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            main.post {
                if (gatt != this@FaceclawNeuralBand.gatt) return@post
                when (newState) {
                    BluetoothProfile.STATE_CONNECTED -> gatt.discoverServices()
                    BluetoothProfile.STATE_DISCONNECTED -> {
                        Log.i(TAG, "disconnected (status $status)")
                        if (status == STALE_BOND_DISCONNECT) dropStaleBond(gatt.device)
                        linkDropped()
                    }
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            main.post { servicesDiscovered(gatt) }
        }

        // Android 13+ calls this one.
        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) =
            onRead(gatt, characteristic, value, status)

        // Android 12 and older call only this one.
        @Deprecated("Replaced by the value overload on Android 13")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) onRead(gatt, characteristic, characteristic.value ?: ByteArray(0), status)
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) =
            onBatteryLevel(gatt, characteristic, value)

        @Deprecated("Replaced by the value overload on Android 13")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) onBatteryLevel(gatt, characteristic, characteristic.value ?: ByteArray(0))
        }

        // GATT runs one operation at a time: the first battery read waits for the subscription.
        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (gatt == this@FaceclawNeuralBand.gatt && descriptor.characteristic.uuid == BATTERY_LEVEL) gatt.readCharacteristic(descriptor.characteristic)
        }

        private fun onRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            if (characteristic.uuid != BATTERY_LEVEL) {
                val copy = value.copyOf()
                main.post { onPsmRead(gatt, copy, status) }
                return
            }
            if (status == BluetoothGatt.GATT_SUCCESS) onBatteryLevel(gatt, characteristic, value)
        }

        private fun onBatteryLevel(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            if (gatt != this@FaceclawNeuralBand.gatt || characteristic.uuid != BATTERY_LEVEL) return
            val level = value.singleOrNull()?.toInt()?.and(0xff) ?: return
            if (level <= 100) applyBattery(level, null)
        }
    }

    private fun servicesDiscovered(gatt: BluetoothGatt) {
        if (gatt != this.gatt) return
        batteryCharacteristic = gatt.getService(BATTERY_SERVICE)?.getCharacteristic(BATTERY_LEVEL)
        val characteristic = gatt.getService(BAND_SERVICE)?.getCharacteristic(PSM_CHARACTERISTIC)
        if (characteristic == null) {
            logLine("Neural Band: this device has no Neural Band input service")
            retry(5000)
            return
        }
        // The first read may trigger Bluetooth pairing (a system prompt). A read can be lost
        // while the bond completes: without an answer in time, start over.
        psmRead = false
        val attempt = generation
        main.postDelayed({
            if (attempt == generation && !psmRead) {
                Log.i(TAG, "the band didn't answer the input channel read; reconnecting")
                retry(2000)
            }
        }, PSM_READ_TIMEOUT_MS)
        if (!gatt.readCharacteristic(characteristic)) retry(3000)
    }

    private fun onPsmRead(gatt: BluetoothGatt, value: ByteArray, status: Int) {
        if (gatt != this.gatt) return
        psmRead = true
        if (status != BluetoothGatt.GATT_SUCCESS || value.size != 2) {
            Log.w(TAG, "reading the input channel failed (status $status)")
            if (status in AUTH_FAILURES) dropStaleBond(gatt.device)
            retry(5000)
            return
        }
        val psm = (value[0].toInt() and 0xff) or ((value[1].toInt() and 0xff) shl 8)
        val attempt = generation
        thread(name = "band-l2cap") { runChannel(gatt.device, psm, attempt) }
        startBattery(gatt, attempt)
    }

    /**
     * The standard GATT battery level, beside the session's battery query: a band can answer
     * that one with "unavailable". Read now, on notification, and every [BATTERY_POLL_MS].
     */
    private fun startBattery(gatt: BluetoothGatt, attempt: Int) {
        val characteristic = batteryCharacteristic ?: return
        val notifies = characteristic.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0
        if (!notifies || !subscribe(gatt, characteristic)) gatt.readCharacteristic(characteristic)
        pollBattery(attempt)
    }

    private fun pollBattery(attempt: Int) {
        main.postDelayed({
            if (attempt != generation) return@postDelayed
            val characteristic = batteryCharacteristic
            if (characteristic != null && session != null && !stopping) gatt?.readCharacteristic(characteristic)
            pollBattery(attempt)
        }, BATTERY_POLL_MS)
    }

    @Suppress("DEPRECATION")
    private fun subscribe(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic): Boolean {
        val descriptor = characteristic.getDescriptor(CCCD) ?: return false
        if (!gatt.setCharacteristicNotification(characteristic, true)) return false
        val enable = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(descriptor, enable) == BluetoothStatusCodes.SUCCESS
        } else {
            descriptor.value = enable
            gatt.writeDescriptor(descriptor)
        }
    }

    private fun now() = SystemClock.elapsedRealtimeNanos() / 1e9

    private fun openSession(device: BluetoothDevice): BandSession {
        // A suspected rejection claims the band again, but only with a Meta session to claim it
        // with; without one the stored identity is still the best bet (a link that merely
        // dropped during trust setup looks the same as a rejection).
        val enrollment = if (identityRejected && metaSessions.hasSavedSession()) null else identities.load(IDENTITY_ID)
        if (enrollment != null) {
            Log.i(TAG, "authenticating with the stored identity")
            claiming = false
            return BandSession(enrollment = enrollment, motion = motion, log = log, schemeGuess = schemeGuess)
        }
        if (!metaSessions.hasSavedSession()) throw MetaSessionInvalidError("Sign in with Meta to claim the band.")
        logLine("Neural Band: claiming the band with the Meta account")
        claiming = true
        claimStage = null
        claimStarted = now()
        identityRejected = false
        Log.i(TAG, "claiming ${device.address}")
        setState("claiming", if (claimRetries > 0) message else "Connecting to the band…")
        return BandSession(ceremony = OwnershipCeremony(IDENTITY_ID, identities), motion = motion, log = log, schemeGuess = schemeGuess)
    }

    private fun runChannel(device: BluetoothDevice, psm: Int, attempt: Int) {
        val session = try {
            synchronized(lock) { openSession(device).also { this.session = it } }
        } catch (e: Exception) {
            fail(e, attempt)
            return
        }
        val channel = try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw IOException("LE L2CAP needs Android 10")
            device.createInsecureL2capChannel(psm).also { it.connect() }
        } catch (e: Exception) {
            Log.w(TAG, "opening the input channel failed: ${e.message}")
            main.post { if (attempt == generation) retry(3000) }
            return
        }
        socket = channel
        if (attempt != generation) {
            runCatching { channel.close() }
            return
        }
        val input = channel.inputStream
        pendingWrites.clear()
        output = channel.outputStream
        val startupDeadline = now() + if (claiming) 180.0 else 30.0
        try {
            synchronized(lock) { queue(session.request()) }
            drain()
            thread(name = "band-tick") { tickLoop(session, attempt, startupDeadline) }
            val buffer = ByteArray(65536)
            while (attempt == generation) {
                val count = input.read(buffer)
                if (count < 0) break
                lastInput = SystemClock.elapsedRealtime()
                val time = now()
                synchronized(lock) {
                    if (this.session !== session) return
                    val result = session.feed(buffer.copyOf(count), time)
                    queue(result.outgoing)
                    result.events.forEach { handle(it, time) }
                    if (stopping && session.stopAcknowledged) main.post { teardown() }
                }
                drain()
            }
            if (attempt == generation) {
                if (claiming) {
                    fail(BandLinkError("The band closed the input channel"), attempt)
                } else {
                    Log.i(TAG, "the band closed the input channel")
                    main.post { if (attempt == generation) { if (stopping) teardown() else retry(2000) } }
                }
            }
        } catch (e: Exception) {
            fail(e, attempt)
        }
    }

    private fun tickLoop(session: BandSession, attempt: Int, startupDeadline: Double) {
        while (attempt == generation) {
            // Fast only while the band is talking: a held tap, a double tap or the dial need
            // 50 ms; idle, the tick has only request deadlines (seconds) to keep.
            val talking = SystemClock.elapsedRealtime() - lastInput < FAST_TICK_WINDOW_MS
            SystemClock.sleep(if (talking) FAST_TICK_MS else IDLE_TICK_MS)
            try {
                val time = now()
                synchronized(lock) {
                    if (this.session !== session) return
                    val bytes = ArrayList<ByteArray>()
                    if (claiming && session.authenticatedPackets == 0 && time - claimStarted >= HANDSHAKE_WAIT_S) {
                        throw BandLinkError(PAIRING_MODE_HINT)
                    }
                    session.tick(time).forEach { handle(it, time) }
                    if (!stopping && wanted) pinches.flush(time).forEach { pinchEdge(it.first, it.second) }
                    taps.flush(time).forEach { emitRecognized(it) }
                    bytes.add(session.flushMotion(time))
                    bytes.add(session.flushGestureHaptics(time))
                    if (session.streamsEnabled && time >= nextBatteryStatus) {
                        nextBatteryStatus = time + 30
                        bytes.add(session.queryBatteryStatus(time))
                    }
                    if (session.streamsEnabled && time - lastSensorRead >= 2 && time - lastStatusQuery >= 2) {
                        lastStatusQuery = time
                        bytes.add(session.queryStreamState())
                    }
                    if (!session.streamsEnabled && !stopping && time >= startupDeadline) {
                        throw BandLinkError("The band took too long to respond. Try reconnecting.")
                    }
                    bytes.forEach(::queue)
                }
                drain()
            } catch (e: Exception) {
                fail(e, attempt)
                break
            }
        }
    }

    // MARK: - Session events (called with `lock` held)

    private fun handle(event: BandEvent, time: Double) {
        when (val payload = event.payload) {
            is BandEvent.Payload.Connected -> if (!stopping) {
                failures = 0
                gestures = GestureRouter()
                taps.reset()
                pinches.reset()
                dial = DialRouter()
                dialEngaged = false
                session?.setGestureHaptics(gestureHaptics)
                val attempt = generation
                main.post { if (attempt == generation && wanted && !stopping) markConnected() }
            }
            is BandEvent.Payload.DataSeen -> lastSensorRead = time
            is BandEvent.Payload.Gesture -> if (!stopping) handleGesture(payload.gesture, time)
            is BandEvent.Payload.DialState -> dialEngaged = payload.engaged
            is BandEvent.Payload.DialTurn -> if (!stopping) {
                val steps = dial.turn(payload.delta, 1.0, time)
                if (steps != 0) emitGesture(if (steps > 0) "dial-up" else "dial-down")
            }
            is BandEvent.Payload.Handedness -> {
                hand = payload.hand
                main.post { sendStatus() }
            }
            is BandEvent.Payload.HandednessFailure -> main.post { logLine("Neural Band: ${payload.message}") }
            is BandEvent.Payload.BatteryStatus -> payload.status?.let { applyBattery(it.level, it.charging) }
            is BandEvent.Payload.CeremonyStage -> {
                claimStage = payload.stage
                main.post {
                    logLine("Neural Band: claim: ${payload.stage}")
                    setState("claiming", payload.stage.replaceFirstChar { it.uppercase() } + "…")
                }
            }
            is BandEvent.Payload.CeremonyHTTP -> runCeremonyExchange(payload.request, generation)
            is BandEvent.Payload.DeviceInfo -> {
                val info = payload.info
                firmware = info.software.ifEmpty { info.firmware }
                Log.i(TAG, "firmware $firmware, hardware ${info.hardware}")
            }
            else -> {}
        }
    }

    private fun handleGesture(message: BandGesture, time: Double) {
        pinches.receive(message, time)?.let { (edge, finger) ->
            taps.touched(message.finger, time)
            pinchEdge(edge, finger)
        }
        val recognized = gestures.gesture(message, time) ?: return
        taps.resolve(recognized, time).forEach { emitRecognized(it) }
    }

    /** Raw pinch edges: a press at once, a hold once the pinch has lasted, the release. */
    private fun pinchEdge(edge: String, finger: Int) {
        when (edge) {
            "touch_down" -> emitGesture("press", finger)
            // An index pinch that turned into the dial is not a hold.
            "tap_start" -> if (!(finger == 0 && dialEngaged)) emitGesture("hold", finger)
            "tap_end" -> emitGesture("release", finger)
        }
    }

    private fun emitRecognized(gesture: RecognizedGesture) {
        when (gesture) {
            is RecognizedGesture.Swipe -> emitGesture("swipe-${gesture.direction.rawValue}")
            is RecognizedGesture.Tap -> {
                val finger = if (gesture.tap.finger == "index") 0 else 1
                when (gesture.tap.action) {
                    "tap" -> emitGesture("tap", finger)
                    "doubletap" -> emitGesture("double-tap", finger)
                    // The band's own hold report duplicates the pinch edges' "hold".
                    else -> {}
                }
            }
        }
    }

    private fun applyBattery(level: Int, charging: Boolean?) {
        val changed = battery != level || (charging != null && this.charging != charging)
        battery = level
        if (charging != null) this.charging = charging
        if (changed) sendStatus()
    }

    private fun markConnected() {
        val device = gatt?.device ?: return
        storedAddress = device.address
        runCatching { device.name }.getOrNull()?.let { storedName = it }
        bondedUnreachable = false
        claimRetries = 0
        guessAttempts = 0
        if (claiming) {
            claiming = false
            // The account was only needed for the claim; the stored identity is enough from here.
            metaSessions.deleteSession()
            logLine("Neural Band: claimed")
        }
        logLine("Neural Band: connected")
        setState("connected", "")
    }

    // MARK: - Claim

    /** The Meta exchanges run on their own thread and answer the band. */
    private fun runCeremonyExchange(request: CeremonyHTTPRequest, attempt: Int) {
        val metaSession = metaSessions.restoreSession()
        if (metaSession == null) {
            main.post { fail(MetaSessionInvalidError("Sign in with Meta to claim the band."), attempt) }
            return
        }
        val client = MetaPairClient(metaSession)
        val name = if (request is CeremonyHTTPRequest.PairRequest) "pair_request" else "pair"
        val started = SystemClock.elapsedRealtime()
        thread(name = "band-claim") {
            try {
                val bytes = when (request) {
                    is CeremonyHTTPRequest.PairRequest -> client.pairRequest(request.data).let { reply ->
                        synchronized(lock) {
                            if (attempt != generation) return@thread
                            session?.ceremonyPairRequestCompleted(reply.signature, reply.receipt)
                        }
                    }
                    is CeremonyHTTPRequest.Pair -> client.pair(request.data).let { reply ->
                        synchronized(lock) {
                            if (attempt != generation) return@thread
                            session?.ceremonyPairCompleted(reply.signature, reply.receipt, reply.devicePublicKey)
                        }
                    }
                }
                Log.i(TAG, "claim: $name exchange done in ${SystemClock.elapsedRealtime() - started} ms")
                if (bytes != null) {
                    queue(bytes)
                    drain()
                }
            } catch (e: Exception) {
                Log.w(TAG, "claim: $name exchange failed: ${e.message}")
                fail(e, attempt)
            }
        }
    }

    // MARK: - Lifecycle

    /** Stops the streams, then disconnects. */
    private fun stop() {
        val bytes = synchronized(lock) {
            val session = session ?: run { teardown(); return }
            if (stopping) return
            stopping = true
            runCatching { session.stop() }.getOrNull()
        }
        if (bytes == null || bytes.isEmpty() || socket == null) {
            teardown()
            return
        }
        queue(bytes)
        drain()
        main.postDelayed({ if (stopping) teardown() }, STOP_WAIT_MS)
    }

    private fun fail(error: Exception, attempt: Int) {
        if (attempt != generation) return
        val wrongGuess = synchronized(lock) {
            val session = session
            session != null && session.schemeGuessInUse != null && session.authenticatedPackets == 0 &&
                error !is MetaSessionInvalidError && guessAttempts < BAND_SCHEME_GUESS_COUNT
        }
        if (wrongGuess) {
            guessAttempts++
            schemeGuess = (schemeGuess + 1) % BAND_SCHEME_GUESS_COUNT
            Log.i(TAG, "error: ${error.message}; trying encryption key guess ${schemeGuess + 1} next")
            claiming = false
            main.post { if (attempt == generation) retry(2000) }
            return
        }
        val storedIdentityPending = synchronized(lock) { session?.storedIdentityPending == true }
        if (error is BandIdentityMismatchError || storedIdentityPending) {
            identityRejected = true
            Log.i(TAG, "stored identity rejected; the next attempt claims again")
            if (error is BandIdentityMismatchError && !metaSessions.hasSavedSession()) {
                // Retrying the same key changes nothing, and there is no account to claim with.
                wanted = false
                main.post {
                    logLine("Neural Band: the band no longer accepts this phone's key")
                    setState("error", RECLAIM_HINT)
                    if (attempt == generation) teardown()
                }
                return
            }
        }
        val text = error.message ?: error.javaClass.simpleName
        val linkFailure = error is BandLinkError || error is IOException
        if (claiming) {
            Log.i(TAG, "claim interrupted at ${claimStage ?: "link setup"}")
            if (linkFailure && claimRetries < MAX_CLAIM_RETRIES) {
                // The band hangs up a link whose setup outlasts its 30 s window, and a band that
                // isn't in pairing mode never answers the identity read: try again, saying so.
                claimRetries++
                val hint = if (claimStage == null) PAIRING_MODE_HINT else "Reconnecting to the band…"
                Log.i(TAG, "retrying the claim ($claimRetries/$MAX_CLAIM_RETRIES)")
                claiming = false
                main.post {
                    setState("claiming", hint)
                    if (attempt == generation) retry(2000)
                }
                return
            }
        }
        // A missing Meta session ends the attempt whether or not a claim was running: retrying
        // changes nothing, and the setup page needs the cause.
        if (claiming || error is MetaSessionInvalidError) {
            val stalled = claiming && claimStage == null && linkFailure
            claiming = false
            // "Sign in" when there was never a session; "expired" only when Meta refused one.
            val expired = error is MetaSessionInvalidError && metaSessions.hasSavedSession()
            if (expired) metaSessions.deleteSession()
            wanted = false
            main.post {
                logLine("Neural Band: claim failed: ${if (stalled) PAIRING_MODE_HINT else text}")
                setState("error", if (stalled) PAIRING_MODE_HINT else text, expired)
                if (attempt == generation) teardown()
            }
            return
        }
        main.post {
            Log.w(TAG, "error: $text")
            if (wanted) setState("connecting", text)
            if (attempt != generation) return@post
            if (wanted) retry(2000) else teardown()
        }
    }

    /** The remembered band's bond: by address, or by name once the band moved to its identity address. */
    private fun bondedDevice(address: String): BluetoothDevice? = runCatching {
        val bonded = adapter?.bondedDevices ?: return@runCatching null
        bonded.firstOrNull { it.address.equals(address, ignoreCase = true) }
            ?: storedName?.let { name -> bonded.firstOrNull { it.name == name } }
    }.getOrNull()

    /** [address] / [name] is the remembered band: the same address, or the same band name at a new one. */
    private fun isRememberedBand(address: String, name: String): Boolean {
        val stored = storedAddress ?: return false
        return stored.equals(address, ignoreCase = true) || (storedName != null && storedName == name)
    }

    /** A bond the band no longer matches (it was factory reset) blocks every pairing until it goes. */
    private fun dropStaleBond(device: BluetoothDevice): Boolean {
        if (device.bondState != BluetoothDevice.BOND_BONDED) return false
        Log.i(TAG, "removing the stale bond so the band can pair again")
        return removeBond(device)
    }

    /** `removeBond` is hidden; reflection is the established way for an app to drop its own bond. */
    private fun removeBond(device: BluetoothDevice): Boolean =
        runCatching { device.javaClass.getMethod("removeBond").invoke(device) as Boolean }.getOrDefault(false)

    private fun forgetBand(address: String) {
        identities.delete(IDENTITY_ID)
        bondedDevice(address)?.let { removeBond(it) }
        identityRejected = false
    }

    /** The band or the system dropped the link (main thread). */
    private fun linkDropped() {
        if (synchronized(lock) { session?.storedIdentityPending == true }) {
            identityRejected = true
            Log.i(TAG, "the band hung up on the stored identity; the next attempt claims again")
        }
        if (stopping || !wanted) teardown() else retry(2000)
    }

    /** Drop everything from the current attempt (main thread); `connectNow` starts a fresh one. */
    private fun teardown() {
        generation++
        stopping = false
        main.removeCallbacksAndMessages(null)
        stopConnectScan()
        runCatching { socket?.close() }
        runCatching { gatt?.disconnect() }
        runCatching { gatt?.close() }
        socket = null
        gatt = null
        batteryCharacteristic = null
        output = null
        pendingWrites.clear()
        synchronized(lock) {
            session = null
            for ((_, finger) in pinches.releaseAll()) emitGesture("release", finger)
            dialEngaged = false
        }
        if (state == "connected") setState(if (wanted) "connecting" else "disconnected", "")
    }

    /** Try again after [delayMs], doubled for each failure in a row up to [MAX_RETRY_MS] (main thread). */
    private fun retry(delayMs: Long) {
        teardown()
        if (!wanted) return
        val delay = (delayMs shl failures.coerceAtMost(4)).coerceAtMost(MAX_RETRY_MS)
        failures++
        Log.i(TAG, "retrying in ${delay / 1000} s")
        main.postDelayed({ connectNow() }, delay)
    }

    companion object {
        private const val TAG = "FaceclawNeuralBand"
        private const val PREFS = "faceclaw_neural_band"
        private const val KEY_ADDRESS = "address"
        private const val KEY_NAME = "name"
        private const val KEY_SCHEME = "scheme"

        /**
         * The stored identity belongs to the one remembered band, not to an address: the band's
         * address changes (a rotating private address before bonding, its identity address after).
         */
        private const val IDENTITY_ID = "band"
        private const val HANDSHAKE_WAIT_S = 30.0

        @Volatile private var instance: FaceclawNeuralBand? = null

        @JvmStatic
        fun getInstance(context: Context): FaceclawNeuralBand =
            instance ?: synchronized(this) { instance ?: FaceclawNeuralBand(context).also { instance = it } }

        /** FaceclawMetaSignInActivity closed, with or without a new session. */
        internal fun metaSignInEnded() {
            instance?.let { band -> band.main.post { band.onMetaSignInEnded() } }
        }

        val BAND_SERVICE: UUID = UUID.fromString("0000feb8-0000-1000-8000-00805f9b34fb")
        val PSM_CHARACTERISTIC: UUID = UUID.fromString("2d41da7c-82b6-42aa-b34e-e2e01df8cc1a")
        val BATTERY_SERVICE: UUID = UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb")
        val BATTERY_LEVEL: UUID = UUID.fromString("00002a19-0000-1000-8000-00805f9b34fb")
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        const val NAME_PREFIX = "meta band"
        const val BONDED_CONNECT_TIMEOUT_MS = 30_000L
        const val MAX_CLAIM_RETRIES = 3
        const val RECLAIM_HINT =
            "The band no longer accepts this phone's key (it was reset or claimed elsewhere). Sign in with Meta, put the band in pairing mode and reconnect to claim it again."
        const val PAIRING_MODE_HINT =
            "The band didn't start the claim. Put it in pairing mode: hold its button for about 3 seconds until it pulses."

        /** HCI 0x3D: the link's MIC failed, the stack's answer to a bond the band no longer shares. */
        const val STALE_BOND_DISCONNECT = 61

        /** GATT insufficient authentication / authorization / encryption and auth failure. */
        val AUTH_FAILURES = setOf(5, 8, 15, 137)

        /** Long enough for a first read that waits out Bluetooth pairing. */
        const val PSM_READ_TIMEOUT_MS = 12_000L
        const val MAX_RETRY_MS = 30_000L
        const val PAIRING_SCAN_MS = 20_000L
        const val STOP_WAIT_MS = 3_000L
        const val BATTERY_POLL_MS = 60_000L

        /** The tick while the band talks, how long after its last message that lasts, and the idle tick. */
        const val FAST_TICK_MS = 50L
        const val FAST_TICK_WINDOW_MS = 1_500L
        const val IDLE_TICK_MS = 250L
    }
}
