package dev.lumen.band

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.concurrent.thread

/**
 * Lumen's enrolled link, scoped to one enrolled Android bond. GATT locates the input
 * channel, L2CAP carries the encrypted band-core session, and Android owns the device bond.
 */
@SuppressLint("MissingPermission")
class BandLink(context: Context, private val listener: GestureDevice.Listener, private val config: Config) :
    GestureDevice {
    interface Config {
        fun paused(): Boolean
        /** A semicolon-separated list of gesture=action bindings. */
        fun mapping(): String
    }

    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private var wanted = false
    private var current: Attempt? = null
    private var failures = 0
    private val reconnect = Runnable { connect() }
    private var stopping = false
    private val finishStop = Runnable { if (stopping) stopNow() }
    @Volatile private var paused = false
    @Volatile private var mapping = ""

    override fun start() = onMain {
        if (wanted) return@onMain
        paused = config.paused()
        mapping = config.mapping()
        failures = 0
        wanted = true
        connect()
    }

    override fun stop() = onMain {
        if (stopping) return@onMain
        if (current?.writingBusy == true) {
            setHandwriting(false)
            stopping = true
            main.postDelayed(finishStop, RESTORE_WAIT_MS)
        } else {
            stopNow()
        }
    }

    private fun stopNow() {
        wanted = false
        stopping = false
        main.removeCallbacks(finishStop)
        closeAttempt()
        listener.onPhase(Phase.STOPPED, null)
    }

    override fun setPaused(paused: Boolean) {
        this.paused = paused
    }

    override fun setMapping(mapping: String) {
        this.mapping = mapping
    }

    /** Main-thread request, applied on this attempt's serialized input channel. */
    fun setPointer(enabled: Boolean): Boolean {
        val attempt = activeAttempt() ?: return false
        if (enabled && (paused || attempt.writingBusy)) return false
        attempt.pointerRequested = enabled
        attempt.requests.add(InputRequest.Pointer(enabled))
        return true
    }

    /** Start or restore the band's writing model; progress arrives through onHandwriting. */
    fun setHandwriting(enabled: Boolean): Boolean {
        val attempt = activeAttempt() ?: return false
        if (attempt.writingRequested == enabled) return true
        if (enabled && (attempt.writingBusy || attempt.pointerRequested)) return false
        attempt.writingRequested = enabled
        attempt.writingBusy = true
        attempt.requests.add(InputRequest.Handwriting(enabled))
        return true
    }

    fun resetHandwritingText(text: String) {
        val attempt = activeAttempt() ?: return
        if (attempt.writingRequested) attempt.requests.add(InputRequest.ResetWriting(text))
    }

    private fun activeAttempt(): Attempt? {
        if (Looper.myLooper() != main.looper || stopping) return null
        return current?.takeIf { it.connected }
    }

    private fun connect() {
        if (!wanted) return
        val identity = Identity.load(app)
        if (identity == null) {
            listener.onLog("Import the owner's band export before connecting")
            stop()
            return
        }
        val device = try {
            val adapter = app.getSystemService(BluetoothManager::class.java)?.adapter
            adapter?.takeIf { it.isEnabled }?.bondedDevices?.firstOrNull {
                it.address.equals(identity.address, ignoreCase = true)
            }
        } catch (_: SecurityException) {
            identity.owner.fill(0)
            listener.onLog("Android Nearby devices permission is unavailable")
            stop()
            return
        }
        if (device == null) {
            identity.owner.fill(0)
            listener.onLog("Waiting for Bluetooth and the band's Android bond")
            retry(5000)
            return
        }
        val attempt = Attempt(device, identity)
        current = attempt
        listener.onPhase(Phase.SEARCHING, attempt.name)
        if (current !== attempt) return
        try {
            attempt.gatt = device.connectGatt(app, true, callback(attempt), BluetoothDevice.TRANSPORT_LE)
            if (attempt.gatt == null) retry(2000)
        } catch (_: Exception) {
            listener.onLog("Android could not open the band's GATT connection")
            retry(2000)
        }
    }

    private fun callback(attempt: Attempt) = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, state: Int) {
            post(attempt) {
                when {
                    status == BluetoothGatt.GATT_SUCCESS && state == BluetoothProfile.STATE_CONNECTED -> {
                        listener.onPhase(Phase.CONNECTING, attempt.name)
                        if (current !== attempt) return@post
                        if (!runCatching { gatt.discoverServices() }.getOrDefault(false)) {
                            retry(2000)
                            return@post
                        }
                        val timeout = Runnable {
                            if (current === attempt && !attempt.connected) {
                                retry(2000)
                            }
                        }
                        attempt.authenticationTimeout?.let(main::removeCallbacks)
                        attempt.authenticationTimeout = timeout
                        main.postDelayed(timeout, AUTHENTICATION_TIMEOUT_MS)
                    }
                    status != BluetoothGatt.GATT_SUCCESS || state == BluetoothProfile.STATE_DISCONNECTED -> {
                        listener.onLog("The band disconnected (GATT status $status)")
                        retry(2000)
                    }
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            post(attempt) {
                val psm = gatt.getService(BAND_SERVICE)?.getCharacteristic(PSM_CHARACTERISTIC)
                val ready = status == BluetoothGatt.GATT_SUCCESS && psm != null &&
                    runCatching { gatt.readCharacteristic(psm) }.getOrDefault(false)
                if (ready) return@post
                listener.onLog("The bonded device's Neural Band input service is unavailable")
                retry(5000)
            }
        }

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) = onRead(characteristic, value, status)

        @Deprecated("Replaced by the value overload on Android 13")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                onRead(characteristic, characteristic.value ?: ByteArray(0), status)
            }
        }

        private fun onRead(characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            if (characteristic.uuid != PSM_CHARACTERISTIC) return
            val bytes = value.copyOf()
            post(attempt) {
                if (attempt.channelStarted) return@post
                if (status != BluetoothGatt.GATT_SUCCESS || bytes.size != 2) {
                    listener.onLog("The band did not provide its input channel")
                    retry(5000)
                    return@post
                }
                val psm = (bytes[0].toInt() and 0xff) or ((bytes[1].toInt() and 0xff) shl 8)
                attempt.channelStarted = true
                thread(name = "faceclaw-band-input") { runChannel(attempt, psm) }
            }
        }
    }

    private fun runChannel(attempt: Attempt, psm: Int) {
        try {
            // The band exposes this channel type. The band-core session applies its own
            // enrollment proof and protocol encryption before allowing gestures.
            attempt.device.createInsecureL2capChannel(psm).use { channel ->
                if (!attempt.attach(channel)) return
                channel.connect()
                val owner = attempt.takeOwner() ?: return
                val handle = try {
                    Bridge.open(owner, attempt.identity.schemeGuess, paused, "", mapping)
                } finally {
                    owner.fill(0)
                }
                if (handle == 0L) throw IOException("Cannot open the band session")
                val session = ChannelSession(attempt, channel, handle)
                try {
                    session.run()
                } finally {
                    session.close()
                }
            }
        } catch (_: LinkageError) {
            post(attempt) {
                listener.onLog("The Neural Band native library could not be loaded")
                stop()
            }
            return
        } catch (_: Exception) {
            post(attempt) { listener.onLog("The band's input channel closed or could not be established") }
        }
        post(attempt) { retry(2000) }
    }

    private inner class ChannelSession(
        private val attempt: Attempt,
        private val channel: BluetoothSocket,
        private var handle: Long,
    ) {
        private val lock = Any()
        @Volatile private var lastInput = 0L
        private var lastStatusCheck = 0L
        private var lastStatus = ""
        private var appliedPaused: Boolean? = null
        private var appliedMapping: String? = null
        private var motion = false
        private var mappingUsesDial = false
        private var holdBindings = emptyList<HoldBinding>()
        private var recoveryChecked = false
        private val writingMarker = AtomicFile(File(
            app.noBackupFilesDir, "neural-band-writing-${attempt.identity.address.replace(':', '-')}.json",
        ))
        private var writingIds = readWritingIds()
        private var ticker: Thread? = null

        fun run() {
            synchronized(lock) {
                attempt.writingBusy = writingIds != null
                applyControls()
                write(Bridge.request(handle))
            }
            ticker = thread(name = "faceclaw-band-tick") {
                try {
                    while (!attempt.cancelled) {
                        val active = attempt.requests.isNotEmpty() ||
                            SystemClock.elapsedRealtime() - lastInput < FAST_TICK_WINDOW_MS
                        Thread.sleep(if (active) FAST_TICK_MS else IDLE_TICK_MS)
                        exchange { Bridge.tick(handle, now()) }
                    }
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                } catch (_: Exception) {
                    // Closing the socket wakes the reader and lets the attempt retry.
                    runCatching { channel.close() }
                }
            }
            val input = channel.inputStream
            val buffer = ByteArray(8192)
            while (!attempt.cancelled) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count == 0) continue
                lastInput = SystemClock.elapsedRealtime()
                exchange { Bridge.feed(handle, buffer.copyOf(count), now()) }
            }
        }

        fun close() {
            ticker?.interrupt()
            // Unblock a simultaneous writer before taking the lock protecting the JNI handle.
            runCatching { channel.close() }
            synchronized(lock) {
                Bridge.close(handle)
                handle = 0L
            }
        }

        private fun applyControls() {
            val nextMapping = mapping
            val mappingChanged = nextMapping != appliedMapping
            if (mappingChanged) {
                Bridge.setMapping(handle, nextMapping)
                appliedMapping = nextMapping
                val bindings = nextMapping.split(';').mapNotNull { pair ->
                    val parts = pair.split('=', limit = 2)
                    if (parts.size == 2) parts[0].trim() to parts[1].trim() else null
                }.toMap()
                holdBindings = listOf("index", "middle").mapNotNull { finger ->
                    val start = bindings["${finger}_hold_start"]?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
                    HoldBinding(start, bindings["${finger}_hold_release"].orEmpty(), bindings["${finger}_hold_cancel"].orEmpty())
                }
                mappingUsesDial = listOf("dial_up", "dial_down").any { !bindings[it].isNullOrEmpty() }
            }
            val nextPaused = paused
            if (nextPaused != appliedPaused || mappingChanged) {
                Bridge.setPaused(handle, nextPaused, now())
                appliedPaused = nextPaused
            }
            val nextMotion = !nextPaused && (mappingUsesDial || attempt.pointerRequested)
            if (nextMotion != motion || mappingChanged) {
                Bridge.setMotion(handle, nextMotion)
                motion = nextMotion
            }
        }

        private fun applyRequests() {
            while (!attempt.cancelled) {
                when (val request = attempt.requests.poll() ?: return) {
                    is InputRequest.Pointer -> Bridge.setPointer(handle, request.enabled, "", now())
                    is InputRequest.Handwriting -> applyWriting(request.enabled)
                    is InputRequest.ResetWriting -> Bridge.resetHandwritingText(handle, request.text)
                }
            }
        }

        private fun applyWriting(enabled: Boolean) {
            if (enabled && !saveWritingIds(0 to 0)) {
                writingFailed("Couldn't record the handwriting restore state.")
                return
            }
            val (collection, model) = writingIds ?: (0 to 0)
            val bytes = try {
                Bridge.setHandwriting(handle, enabled, collection, model, now())
            } catch (error: IOException) {
                writingFailed(error.message ?: "Couldn't switch the band's handwriting mode.")
                return
            }
            write(bytes)
        }

        private fun readWritingIds(): Pair<Int, Int>? {
            if (!writingMarker.baseFile.exists()) return null
            return runCatching {
                val ids = JSONObject(writingMarker.readFully().decodeToString())
                ids.optInt("collection") to ids.optInt("model")
            }.getOrDefault(0 to 0)
        }

        /** Persist before touching the band, so restoration works after an interrupted capture. */
        private fun saveWritingIds(ids: Pair<Int, Int>): Boolean {
            if (writingIds == ids) return true
            return try {
                val output = writingMarker.startWrite()
                try {
                    val record = JSONObject().put("collection", ids.first).put("model", ids.second)
                    output.write(record.toString().encodeToByteArray())
                    writingMarker.finishWrite(output)
                } catch (error: IOException) {
                    writingMarker.failWrite(output)
                    throw error
                }
                writingIds = ids
                true
            } catch (_: IOException) {
                false
            }
        }

        private fun recoverWriting() {
            val (collection, model) = writingIds ?: return
            val bytes = try {
                Bridge.recoverHandwriting(handle, collection, model, now())
            } catch (error: IOException) {
                writingFailed(error.message ?: "Couldn't restore the band's handwriting mode.")
                return
            }
            write(bytes)
        }

        private fun writingFailed(problem: String) {
            val event = JSONObject().put("type", "state").put("phase", "finished")
                .put("verified", false).put("problem", problem)
            post(attempt) { publishWriting(event) }
        }

        private fun processWriting(event: JSONObject) {
            if (event.optString("type") != "state") return
            val collection = event.optInt("collection_id", 0)
            val model = event.optInt("model_id", 0)
            if (event.optString("phase") == "finished" && event.optBoolean("verified")) {
                writingMarker.delete()
                writingIds = null
            } else if (collection > 0 && model > 0 && !saveWritingIds(collection to model)) {
                // The original marker is enough to rediscover the settings on recovery.
                post(attempt) { listener.onLog("Couldn't save the band's handwriting settings IDs") }
            }
        }

        private fun publishWriting(event: JSONObject) {
            if (event.optString("type") == "text" && !attempt.writingRequested) return
            if (event.optString("type") == "state" && event.optString("phase") == "finished") {
                attempt.writingRequested = false
                attempt.writingBusy = false
            }
            if (attempt.connected && !stopping) listener.onHandwriting(event)
            if (stopping && !attempt.writingBusy) stopNow()
        }

        private fun exchange(send: () -> ByteArray): Unit = synchronized(lock) {
            if (attempt.cancelled || handle == 0L) return@synchronized
            applyControls()
            applyRequests()
            write(send())
            val actions = Bridge.actions(handle).let { if (it.isEmpty()) emptyList() else it.lines() }
            val lines = Bridge.log(handle)
            val time = SystemClock.elapsedRealtime()
            val status = if (actions.isNotEmpty() || lines.isNotEmpty() || time - lastStatusCheck >= STATUS_EVERY_MS) {
                lastStatusCheck = time
                Bridge.status(handle).takeIf { it != lastStatus }?.also { lastStatus = it }?.let(::JSONObject)
            } else null
            if (!recoveryChecked && status?.optBoolean("connected") == true) {
                recoveryChecked = true
                recoverWriting()
            }
            val pointer = if (attempt.pointerRequested) Bridge.pointer(handle, now()) else null
            val writing = Bridge.handwritingEvents(handle).lineSequence().filter(String::isNotEmpty)
                .map(::JSONObject).onEach(::processWriting).toList()
            val holds = holdBindings
            if (status != null || actions.isNotEmpty() || lines.isNotEmpty() ||
                pointer?.isNotEmpty() == true || writing.isNotEmpty()
            ) {
                post(attempt) {
                    if (status != null) {
                        if (status.optBoolean("connected") && !attempt.connected) {
                            attempt.connected = true
                            failures = 0
                            attempt.authenticationTimeout?.let(main::removeCallbacks)
                            attempt.authenticationTimeout = null
                            listener.onPhase(Phase.CONNECTED, attempt.name)
                        } else if (!status.optBoolean("connected") && attempt.connected) {
                            retry(2000)
                            return@post
                        }
                        if (current !== attempt) return@post
                        listener.onStatus(status)
                    }
                    if (current !== attempt) return@post
                    if (lines.isNotEmpty()) lines.lineSequence().forEach(listener::onLog)
                    if (attempt.connected && !stopping) {
                        publishActions(attempt, actions, holds)
                        if (current === attempt && attempt.pointerRequested && pointer?.isNotEmpty() == true) {
                            listener.onPointer(pointer)
                        }
                    }
                    for (event in writing) {
                        if (current !== attempt) break
                        publishWriting(event)
                    }
                }
            }
        }

        private fun write(bytes: ByteArray) {
            if (bytes.isNotEmpty()) channel.outputStream.write(bytes)
        }
    }

    private fun retry(delayMs: Long) {
        if (stopping) {
            stopNow()
            return
        }
        closeAttempt()
        if (!wanted) return
        listener.onPhase(Phase.SEARCHING, null)
        val delay = (delayMs shl failures.coerceAtMost(4)).coerceAtMost(MAX_RETRY_MS)
        failures = (failures + 1).coerceAtMost(4)
        main.postDelayed(reconnect, delay)
    }

    private fun closeAttempt() {
        main.removeCallbacks(reconnect)
        val attempt = current ?: return
        current = null
        attempt.authenticationTimeout?.let(main::removeCallbacks)
        attempt.cancel()
        runCatching { attempt.gatt?.disconnect() }
        runCatching { attempt.gatt?.close() }
        val cancelled = attempt.activeHolds.map(HoldBinding::cancel).filter(String::isNotEmpty)
        if (cancelled.isNotEmpty()) listener.onActions(cancelled)
    }

    private fun publishActions(attempt: Attempt, actions: List<String>, holds: List<HoldBinding>) {
        val visible = actions.filter { action ->
            if (action == POINTER_OFF) {
                attempt.pointerRequested = false
                true
            } else if (attempt.activeHolds.removeAll { it.cancel == action || it.release == action }) {
                true
            } else if (!paused) {
                holds.firstOrNull { it.start == action }?.let { attempt.activeHolds.add(it) }
                true
            } else {
                false
            }
        }
        if (visible.isNotEmpty()) listener.onActions(visible)
    }

    private fun post(attempt: Attempt, block: () -> Unit) {
        main.post { if (current === attempt && wanted) block() }
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == main.looper) block() else main.post { block() }
    }

    private sealed interface InputRequest {
        data class Pointer(val enabled: Boolean) : InputRequest
        data class Handwriting(val enabled: Boolean) : InputRequest
        data class ResetWriting(val text: String) : InputRequest
    }

    private data class HoldBinding(val start: String, val release: String, val cancel: String)

    private class Attempt(val device: BluetoothDevice, val identity: Identity.Record) {
        val name = runCatching { device.name }.getOrNull()
        var gatt: BluetoothGatt? = null
        var channelStarted = false
        var connected = false
        val requests = ConcurrentLinkedQueue<InputRequest>()
        val activeHolds = mutableSetOf<HoldBinding>()
        @Volatile var pointerRequested = false
        @Volatile var writingRequested = false
        @Volatile var writingBusy = false
        var authenticationTimeout: Runnable? = null
        private var socket: BluetoothSocket? = null
        @Volatile var cancelled = false
            private set

        @Synchronized
        fun attach(channel: BluetoothSocket): Boolean {
            if (cancelled) return false
            socket = channel
            return true
        }

        @Synchronized
        fun takeOwner(): ByteArray? = if (cancelled) null else identity.owner.copyOf().also {
            identity.owner.fill(0)
        }

        fun cancel() {
            val channel = synchronized(this) {
                cancelled = true
                identity.owner.fill(0)
                socket.also { socket = null }
            }
            runCatching { channel?.close() }
        }
    }

    internal companion object {
        val BAND_SERVICE: UUID = UUID.fromString("0000feb8-0000-1000-8000-00805f9b34fb")
        val PSM_CHARACTERISTIC: UUID = UUID.fromString("2d41da7c-82b6-42aa-b34e-e2e01df8cc1a")
        private const val POINTER_OFF = "pointer.off"
        private const val RESTORE_WAIT_MS = 2_500L
        private const val AUTHENTICATION_TIMEOUT_MS = 20_000L
        private const val MAX_RETRY_MS = 30_000L
        private const val FAST_TICK_MS = 50L
        private const val FAST_TICK_WINDOW_MS = 1_500L
        private const val IDLE_TICK_MS = 250L
        private const val STATUS_EVERY_MS = 200L
        private fun now() = SystemClock.elapsedRealtimeNanos() / 1e9
    }
}
