package com.faceclaw.app

import android.annotation.SuppressLint
import android.bluetooth.BluetoothGatt
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log

import java.io.PrintWriter
import java.io.StringWriter
import java.util.ArrayDeque
import java.util.ArrayList
import java.util.Arrays
import java.util.Collections
import java.util.HashMap
import java.util.Locale
import java.util.Random

@SuppressLint("MissingPermission")
class FaceclawBleCommunicator(context: Context, rightAddress: String?, leftAddress: String?, ringAddress: String?) : FaceclawBleListener, Runnable {
    companion object {
        private const val TAG = "FaceclawComm"

        // Local metadata for custom-command bookkeeping, not an EvenHub container.
        // Submitted frames supply pixel geometry; the stock layout only captures input.
        private val DASHBOARD_TILE: BleProtocol.ImageTileOptions =
            BleProtocol.ImageTileOptions("img00", 10, 0, 0, 576, 288)

        private const val G2_SCREEN_WAKE_LOCK_TAG = "Faceclaw:G2Screen"
        private const val FACECLAW_WAKE_LEASE_RENEW_MS = 45_000L
        private const val FACECLAW_WAKE_CONTROL_WAIT_MS = 1_500L
        private const val CFW_CLEANUP_WAIT_MS = 4_000L
        private const val COMPASS_REPORT_INTERVAL_MS = 100
        private const val COMPASS_MIN_CHANGE_DEGREES = 0

        // A timed-out benchmark message aborts the run, but its already-in-flight
        // peers still time out one by one; keep the window comfortably below
        // MAX_CONSECUTIVE_ACK_TIMEOUTS so a dead run can't escalate into a
        // transport-failure reconnect all by itself.
        private const val BENCHMARK_MAX_WINDOW = 6

        // The most recently started communicator; lets app worker threads submit
        // surface frames without holding a cross-isolate reference to the bridge
        // object (JS wrappers do not cross isolates, but the Java instance does).
        @Volatile private var activeInstance: FaceclawBleCommunicator? = null

        @JvmStatic
        fun getActive(): FaceclawBleCommunicator? {
            return activeInstance
        }

        private fun chargingStatusText(battery: Int): String {
            return if (battery >= 0)
                "Glasses charging. Battery $battery%."
            else
                "Glasses charging."
        }

        private fun timestamp(elapsedMs: Long): String {
            val wallMs = System.currentTimeMillis()
            return String.format(Locale.US, "%tF %tT.%tL elapsed=%dms", wallMs, wallMs, wallMs, elapsedMs)
        }

        private fun requireAddress(name: String, address: String?): String {
            if (address == null || address.trim().isEmpty()) {
                throw IllegalArgumentException("$name is required")
            }
            return address.trim()
        }

        private fun hex(data: ByteArray?): String {
            if (data == null || data.isEmpty()) {
                return ""
            }
            val out = CharArray(data.size * 2)
            val digits = "0123456789abcdef".toCharArray()
            for (i in data.indices) {
                val value = data[i].toInt() and 0xff
                out[i * 2] = digits[value ushr 4]
                out[i * 2 + 1] = digits[value and 0x0f]
            }
            return String(out)
        }

        private fun safeMessage(t: Throwable?): String {
            if (t == null) {
                return "unknown"
            }
            val writer = StringWriter()
            t.printStackTrace(PrintWriter(writer))
            val trace = writer.toString()
            if (trace.trim().isNotEmpty()) {
                return trace
            }
            val message = t.message
            return if (message == null || message.trim().isEmpty()) t.toString() else message
        }
    }

    private val appContext: Context = context.applicationContext
    init {
        FrameTimings.getInstance().init(appContext)
    }
    private val powerManager: PowerManager = appContext.getSystemService(Context.POWER_SERVICE) as PowerManager
    private val keyguardManager: KeyguardManager? = appContext.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager?
    private val bleManager: FaceclawBleManager = FaceclawBleManager(appContext)
    private val interruptibleSleep = InterruptibleSleep()
    private val lock = java.lang.Object()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val rightAddress: String = requireAddress("rightAddress", rightAddress)
    private val leftAddress: String = requireAddress("leftAddress", leftAddress)
    private val ringAddress: String = ringAddress?.trim() ?: ""

    @Volatile private var listener: FaceclawBleCommunicatorListener? = null
    private val imuListeners: MutableList<FaceclawImuListener> =
        java.util.concurrent.CopyOnWriteArrayList()
    /** A compass subscriber plus the Looper it registered from (see addCompassListener). */
    private class CompassSubscription(
        @JvmField val listener: FaceclawCompassListener,
        @JvmField val handler: Handler,
    )

    private val compassSubscriptions: MutableList<CompassSubscription> =
        java.util.concurrent.CopyOnWriteArrayList()
    private val ambientLightListeners: MutableList<FaceclawAmbientLightListener> =
        java.util.concurrent.CopyOnWriteArrayList()
    private val micStatusListeners: MutableList<FaceclawMicStatusListener> =
        java.util.concurrent.CopyOnWriteArrayList()
    @Volatile private var workerThread: Thread? = null
    @Volatile private var running = false
    @Volatile private var userDisconnectRequested = false
    // Set when a connect attempt failed while an arm's Android bond is gone:
    // retrying is pointless until the user re-pairs, so the worker loop parks
    // instead of redialing. Cleared by start() (a fresh explicit connect).
    @Volatile private var reconnectHalted = false

    private var phase = "disconnected"
    private var status = "Disconnected."

    private var rightConnected = false
    private var leftConnected = false
    private var ringConnected = false
    private var ringNotificationsReady = false
    private var sessionReady = false
    private var fixedLayoutCreated = false
    private var shutdownRequested = false
    // CFW firmware-debug-flags overlay (mode 7). Desired value pushed from TS; the
    // sub-op last sent this session (-1 = not yet), reset on (re)connect so the
    // overlay state is re-asserted on every reconnect and whenever the value changes.
    @Volatile private var firmwareDebugFlagsEnabled = false
    private var firmwareDebugFlagsLastSent = -1
    // Desired CFW mode-10 compass state. It survives reconnects; lastSent is
    // reset with each session so an open Compass window is re-asserted.
    /**
     * Who currently wants the stock compass running (the Compass window, the
     * Navigate worker, ...). The magnetometer is one shared resource, so it
     * stays on while any owner holds it and is released when the last lets go;
     * this keeps one app's release from silently switching off another's feed.
     */
    private val compassOwners: MutableSet<String?> = HashSet()
    private var compassControlLastSent = -1
    // Whether the glasses-side compass may still be running: set when an enable
    // is enqueued, cleared only when a disable is acked. Drives the forced
    // disable sent ahead of an EvenHub shutdown/suspend, since a pending
    // disable can be wiped by the shutdown's queue flush and the retry loop
    // does not run while shutdownRequested (magnetometer left on = battery drain).
    private var compassMaybeOn = false
    private var startupProbePending = false
    // Desired ownership of CFW's fail-open stock-wake lease (dashboard launch
    // and Even AI foreground takeover). This survives a transport reconnect;
    // the lease itself is volatile firmware state and is re-acquired once both
    // arms are ready.
    private var faceclawWakeLeaseEnabled = false
    private var lastFaceclawWakeLeaseQueuedAtMs = 0L
    private var faceclawWakeControlGeneration = 0
    private var faceclawWakeControlSentCount = 0
    private var lastFaceclawFramebufferLeaseQueuedAtMs = 0L
    private var faceclawFramebufferControlGeneration = 0
    private var faceclawFramebufferControlSentCount = 0
    private var faceclawWakePendingNonce = -1
    /**
     * The last firmware-info read said the glasses run Faceclaw's custom
     * firmware. Gates the private modes (cleanup, resource cache, ...) so stock
     * or third-party firmware never sees them; the TS side checks the actual
     * revision and disconnects on a mismatch, so no per-feature gating is
     * needed here.
     */
    private var customFirmwareDetected = false
    private var cfwCleanupDelivered = false
    private var lastCfwCleanupAckMagic = 0

    private var reconnectAfterMs = 0L
    private var ringReconnectAfterMs = 0L
    private var lastAckAtMs = 0L
    private var lastIncomingAtMs = 0L
    private var lastHeartbeatSentAtMs = 0L
    private var lastHeartbeatAckedAtMs = 0L
    private var lastConnectionOrInputAtMs = 0L
    private var lastBatteryRefreshAtMs = 0L
    private var imageRetryAfterMs = 0L
    private var lastSessionReadyAtMs = 0L
    private var lastEvenAppConflictAtMs = 0L
    private var consecutiveAckTimeouts = 0
    private var lastAudioControlAckMagic = 0

    private val connectionOptions = ConnectionOptions()
    private val magicPool = BleMagicPool(AndroidProtocolPlatform)
    private val messageBuilder = MessageBuilder(magicPool)
    private var nextTransportSeq = 0x40
    private var nextMapSessionId = 0
    private var nextImageUpdateId = 1
    // Wire frame id for mode-3 deltas (CFW reorder/skip/dup diagnostic). uint16,
    // advanced by 1 per emitted delta; kept in [1, 0xfffe] to avoid the CFW's
    // 0xffff "empty" sentinel.
    private var nextImageFrameId = 1
    private var lastShutdownAckMagic = 0
    private var lastShutdownExitAtMs = 0L
    private var headsetBattery = -1
    private var headsetCharging = -1
    private var ringBattery = -1
    private var ringCharging = -1
    // Silent mode: 1 = on, 0 = off, -1 = not yet known. See updateSilentModeLocked.
    private var silentMode = -1
    private var wearState = -1
    private var phoneLockState = -1
    private var lastPhoneLockCheckAtMs = 0L
    private var phoneLockReceiverRegistered = false
    private var audioCaptureActive = false
    private var firmwareInfoQueried = false
    // Glasses are in the charging case: nobody is wearing them, so display
    // communication pauses and only battery polls flow (see driveSession).
    private var chargingMode = false
    @Volatile private var audioPacketListener: FaceclawAudioPacketListener? = null
    private var g2ScreenWakeLock: PowerManager.WakeLock? = null

    // BLE bandwidth benchmark (Developer app). Streams no-op image payloads
    // (CFW mode 7 with an unused sub-op: parsed, acked, and discarded — stock
    // firmware likewise ignores unknown image modes) for a fixed duration with
    // a selectable message size and pipeline window, then reports throughput.
    // While active, desired-frame sends are held back and heartbeats are
    // satisfied by the benchmark's own acks, so the stream is the only image
    // traffic. All state below is guarded by `lock`; results are read with
    // getBandwidthBenchmarkStatus() and survive until the next run starts.
    private var benchmarkActive = false
    private var benchmarkAborted = false
    private val benchmarkRandom = Random()
    private var benchmarkMessageSize = 0
    private var benchmarkWindowSize = 0
    private var benchmarkDurationMs = 0
    private var benchmarkLinkMode = 0
    private var benchmarkLinkPending = false
    private var benchmarkReadyAtMs = 0L
    private var benchmarkStartAtMs = 0L     // first benchmark write; 0 until then
    private var benchmarkDeadlineAtMs = 0L  // start + duration; MAX_VALUE until first write
    private var benchmarkLastAckAtMs = 0L
    private var benchmarkEndAtMs = 0L       // 0 while running; set when the run drains
    private var benchmarkMessagesSent = 0
    private var benchmarkMessagesAcked = 0
    private var benchmarkTimeouts = 0
    private var benchmarkPayloadBytesAcked = 0L
    private var benchmarkWireBytesAcked = 0L

    private val phoneLockReceiver: BroadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            emitPhoneLockStateIfChanged(true)
            interruptibleSleep.interrupt()
        }
    }

    private var displayedFingerprint = ""
    // The frame the firmware shadow will hold once the current image pipeline
    // drains: the most recently ENQUEUED image (headerless packed 4bpp, see
    // BmpUtil.pack4bppFromGray8), which is the correct base for the next delta
    // when frames are pipelined. Set at enqueue; cleared whenever the image
    // pipeline is cleared (clearAllMessagesLocked / clearMessagesOfKindLocked
    // "image"), so it is only ever read while it holds a valid current-session base.
    private var lastEnqueuedPacked: ByteArray = ByteArray(0)
    private var lastEnqueuedWidth = 0
    private var lastEnqueuedHeight = 0
    private var lastEnqueuedFingerprint = ""
    private val imageUpdateStats: MutableMap<Int, BleImageOptimizer.ImageUpdateStats> = HashMap()

    private val desiredTilesLock = Any()
    private var desiredFingerprint = ""
    // Headerless packed 4bpp frame (see BmpUtil.pack4bppFromGray8) plus its
    // pixel dimensions.
    private var desiredPacked: ByteArray? = ByteArray(0)
    private var desiredWidth = 0
    private var desiredHeight = 0
    private var desiredPaintMs = 0
    private var desiredFrameId = 0
    // Screen-space deferred draws (glyphs + images) whose pixels are baked
    // into desiredPacked; the resource-cache planner may replay them as
    // on-glasses cached draws.
    private var desiredDraws: Array<SurfaceCompositor.ScreenDraw>? = arrayOf()
    // (frame, reason) of the last "waiting to send" line, so a frame that
    // stalls for seconds records one line per state change (see
    // noteImageStallLocked). Send-loop thread only.
    private var stallFrameId = 0
    private var stallReason = ""
    // Highest compositor sequence stored as the desired frame; composites that
    // lost a store race to a newer one are discarded (their content is already
    // included in the newer composite).
    private var lastStoredCompositeSeq = 0L

    // Wire submissions need screenGray + the shell scene, never preview pixels.
    // Preview/screenshot/recording callers render those explicitly on demand.
    private val compositor = SurfaceCompositor(false)

    // Phone-side model of the CFW's 192 KiB resource cache.
    // Reset whenever the image pipeline / EvenHub session is torn down: the
    // firmware frees the cache with the fb lease, and after any resync the
    // cheap safe assumption is an empty cache (glyphs re-upload lazily).
    private val resourceCache = ResourceCacheState()
    private val scenePlanner = ScenePlanner(resourceCache)
    private var desiredShellScene: ShellScene = ShellScene.EMPTY

    private val pendingMessages = ArrayDeque<OutboundMessage>()
    private val cfwTransports = arrayOf(CfwTransport(AndroidProtocolPlatform), CfwTransport(AndroidProtocolPlatform))
    private val inFlightMessages = ArrayDeque<OutboundMessage>()
    private var prewrittenMessage: OutboundMessage? = null
    private var prewrittenFrames: List<ByteArray> = Collections.emptyList()

    // Active animated-GIF screen recording, or null when idle. Frames are
    // pushed by recordScreenFrame(), which the TS side calls at each
    // phone-preview flush.
    @Volatile private var screenRecorder: GifScreenRecorder? = null

    init {
        bleManager.setListener(this)
        val phoneLockFilter = IntentFilter()
        phoneLockFilter.addAction(Intent.ACTION_SCREEN_ON)
        phoneLockFilter.addAction(Intent.ACTION_SCREEN_OFF)
        phoneLockFilter.addAction(Intent.ACTION_USER_PRESENT)
        appContext.registerReceiver(phoneLockReceiver, phoneLockFilter)
        phoneLockReceiverRegistered = true
    }


    fun setListener(listener: FaceclawBleCommunicatorListener?) {
        this.listener = listener
        emitState()
        emitPhoneLockStateIfChanged(true)
    }

    fun start() {
        synchronized(lock) {
            if (running) {
                return
            }
            running = true
            userDisconnectRequested = false
            reconnectHalted = false
            shutdownRequested = false
            activeInstance = this
            val thread = Thread(this, "FaceclawBleCommunicator")
            workerThread = thread
            thread.start()
        }
    }

    fun disconnect() {
        /* On the normal path DashboardController already sent mode 11 after
         * quiescing its producers. Also cover direct/early close callers here;
         * a successful cleanup must remain the final BLE message. Older CFWs
         * fall back to the standalone framebuffer-lease release. */
        if (!cfwCleanupDelivered && !sendCfwCleanup()) {
            releaseFaceclawFramebufferLease()
        }
        val threadToJoin: Thread?
        synchronized(lock) {
            userDisconnectRequested = true
            running = false
            audioCaptureActive = false
            audioPacketListener = null
            threadToJoin = workerThread
        }
        setStateDisplay("disconnecting", "Disconnecting...")
        interruptibleSleep.interrupt()
        if (threadToJoin != null) {
            threadToJoin.interrupt()
            try {
                threadToJoin.join(5_000)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        synchronized(lock) {
            workerThread = null
            resetSessionStateLocked()
            clearAllMessagesLocked("disconnect")
            // Unknown until the next connection's first push or settings poll.
            silentMode = -1
        }
        bleManager.disconnect(rightAddress)
        bleManager.disconnect(leftAddress)
        if (hasRingAddress()) {
            bleManager.disconnect(ringAddress)
        }
        bleManager.close()
        releaseG2ScreenWakeLock()
        setStateDisplay("disconnected", "Disconnected.")
    }

    fun close() {
        if (activeInstance === this) {
            activeInstance = null
        }
        disconnect()
        for (transport in cfwTransports) transport.close()
        if (phoneLockReceiverRegistered) {
            phoneLockReceiverRegistered = false
            appContext.unregisterReceiver(phoneLockReceiver)
        }
    }

    fun setG2ScreenOn(screenOn: Boolean) {
        mainHandler.post { updateG2ScreenWakeLock(screenOn) }
    }

    fun setFirmwareDebugFlags(enabled: Boolean) {
        // Just record it; the drive loop emits the mode-7 control message when the
        // display path is ready and idle, and re-emits when this value changes.
        firmwareDebugFlagsEnabled = enabled
    }

    fun startG2AudioCapture(listener: FaceclawAudioPacketListener?): Boolean {
        if (listener == null) {
            throw IllegalArgumentException("listener is required")
        }
        var magic = 0
        synchronized(lock) {
            if (!running || !sessionReady || shutdownRequested || !fixedLayoutCreated) {
                logLine("skip G2 mic enable; EvenHub display path not ready")
                return false
            }
            audioPacketListener = listener
            val message = createAudioControlMessageLocked(true)
            magic = message.magic
            pendingMessages.addFirst(message)
            logLine("queue G2 mic enable")
        }
        interruptibleSleep.interrupt()
        return waitForAudioControlAck(magic, "enable")
    }

    fun stopG2AudioCapture() {
        var magic = 0
        synchronized(lock) {
            audioPacketListener = null
            audioCaptureActive = false
            clearMessagesOfKindLocked("audio-control")
            if (running && sessionReady) {
                val message = createAudioControlMessageLocked(false)
                magic = message.magic
                pendingMessages.addFirst(message)
                logLine("queue G2 mic disable")
            }
        }
        interruptibleSleep.interrupt()
        if (magic != 0) {
            waitForAudioControlAck(magic, "disable")
        }
    }

    fun isSessionReady(): Boolean {
        synchronized(lock) {
            return running && sessionReady
        }
    }

    /**
     * Whether the glasses mic is enabled right now. The enable lives in the
     * current EvenHub session, so it dies with a transport drop, the charging
     * case, or a suspend — silently, from the phone's point of view. Callers
     * that track a capture across those events must check this rather than
     * assume their earlier enable still holds.
     */
    fun isAudioCaptureActive(): Boolean {
        synchronized(lock) {
            return running && sessionReady && !shutdownRequested && audioCaptureActive
        }
    }

    /**
     * Acquire/renew or release CFW's volatile wake-takeover lease on both
     * arms. Delivery (not a protocol ACK) is awaited so a caller can ensure
     * the fail-open firmware policy is installed before relying on wakeword
     * interception or suspending EvenHub.
     */
    fun setFaceclawWakeLeaseEnabled(enabled: Boolean): Boolean {
        val generation: Int
        synchronized(lock) {
            faceclawWakeLeaseEnabled = enabled
            if (!running || !sessionReady) {
                return !enabled
            }
            generation = enqueueFaceclawWakeControlLocked(
                if (enabled) BleProtocol.FACECLAW_WAKE_OP_ACQUIRE else BleProtocol.FACECLAW_WAKE_OP_RELEASE,
                0,
                true
            )
            if (!enabled) {
                faceclawWakePendingNonce = -1
            }
        }
        interruptibleSleep.interrupt()
        return waitForFaceclawWakeControlDelivery(generation, FACECLAW_WAKE_CONTROL_WAIT_MS)
    }

    /**
     * Wait until the recreated layout and retained compositor frame have both
     * landed. If this wake came from CFW's deferred double tap, READY
     * is then sent to both arms to cancel their stock-dashboard fallback.
     */
    fun awaitEvenHubSessionReady(timeoutMs: Int): Boolean {
        val deadline = SystemClock.elapsedRealtime() + Math.max(0, timeoutMs)
        var readyGeneration = 0
        synchronized(lock) {
            while (running && sessionReady) {
                var frameReady = false
                synchronized(desiredTilesLock) {
                    frameReady = desiredFingerprint.isNotEmpty()
                        && desiredFingerprint == displayedFingerprint
                }
                if (!shutdownRequested && fixedLayoutCreated && frameReady) {
                    if (faceclawWakePendingNonce >= 0) {
                        readyGeneration = enqueueFaceclawWakeControlLocked(
                            BleProtocol.FACECLAW_WAKE_OP_READY,
                            faceclawWakePendingNonce,
                            true
                        )
                        faceclawWakePendingNonce = -1
                    }
                    break
                }
                val remaining = deadline - SystemClock.elapsedRealtime()
                if (remaining <= 0) {
                    return false
                }
                try {
                    lock.wait(Math.min(remaining, 100L))
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return false
                }
            }
            if (!running || !sessionReady) {
                return false
            }
        }
        if (readyGeneration != 0) {
            interruptibleSleep.interrupt()
            if (!waitForFaceclawWakeControlDelivery(readyGeneration, FACECLAW_WAKE_CONTROL_WAIT_MS)) {
                logLine("wake READY delivery not confirmed before fallback deadline")
            }
        }
        return true
    }

    /**
     * Enable or disable the IMU (accelerometer) report stream. Fire-and-forget:
     * the control message is queued ahead of other traffic; readings arrive via
     * registered FaceclawImuListeners. reportFrq is the requested sample rate
     * (ignored on disable).
     */
    fun setImuReportEnabled(enable: Boolean, reportFrq: Int) {
        synchronized(lock) {
            if (!running || !sessionReady) {
                logLine("skip IMU " + (if (enable) "enable" else "disable") + "; session not ready")
                return
            }
            clearMessagesOfKindLocked("imu-control")
            val message = messageBuilder.enableOrDisableImu(enable, reportFrq)
            message.onTimeout = MessageCallback { logLine("IMU control ack timeout") }
            pendingMessages.addFirst(message)
            logLine("queue IMU " + (if (enable) "enable freq=$reportFrq" else "disable"))
        }
        interruptibleSleep.interrupt()
    }

    /**
     * Enable/disable the stock compass through CFW image-handler mode 10. The
     * desired state is retained across reconnects; headings arrive through
     * stock sid-0x08 navigation notifications and FaceclawCompassListeners.
     */
    fun setCompassEnabled(enable: Boolean) {
        setCompassEnabled("compass", enable)
    }

    /**
     * As above, on behalf of a named owner. The compass runs while at least
     * one owner has enabled it; an owner disabling it only takes effect once
     * no other owner still wants it.
     */
    fun setCompassEnabled(owner: String?, enable: Boolean) {
        synchronized(lock) {
            val before = compassOwners.isNotEmpty()
            if (enable) {
                compassOwners.add(owner)
            } else {
                compassOwners.remove(owner)
            }
            val wanted = compassOwners.isNotEmpty()
            if (wanted == before && compassControlLastSent == (if (wanted) 1 else 0)) {
                logLine("compass " + (if (enable) "enable" else "disable") + " by " + owner
                    + "; state unchanged (owners=" + compassOwners + ")")
                return
            }
            compassControlLastSent = -1
            clearMessagesOfKindLocked("compass-control")
            if (running && sessionReady && !shutdownRequested && fixedLayoutCreated) {
                enqueueCompassControlLocked(true, wanted)
            } else {
                logLine("defer compass " + (if (enable) "enable" else "disable") + "; display path not ready")
            }
        }
        interruptibleSleep.interrupt()
    }

    /**
     * Set the lens brightness. Fire-and-forget, like the IMU control: the
     * message is queued ahead of other traffic and any not-yet-sent brightness
     * message is superseded. When autoAdjust is true the ambient-light sensor
     * drives brightness and brightnessLevel is ignored; otherwise
     * brightnessLevel (0-100) is applied directly.
     */
    fun setBrightness(autoAdjust: Boolean, brightnessLevel: Int) {
        synchronized(lock) {
            if (!running || !sessionReady) {
                logLine("skip brightness set; session not ready")
                return
            }
            clearMessagesOfKindLocked("brightness-control")
            val message = messageBuilder.setBrightness(autoAdjust, brightnessLevel)
            message.onTimeout = MessageCallback { logLine("brightness control ack timeout") }
            pendingMessages.addFirst(message)
            logLine("queue brightness " + (if (autoAdjust) "auto" else "level=$brightnessLevel"))
        }
        interruptibleSleep.interrupt()
    }

    /**
     * Enable the stock wear detector, then ask CFW to emit its current cached
     * state. The queue order matters: the query must run after the setting is
     * applied, including on a fresh install where wear detection was disabled.
     */
    fun enableWearDetectionAndRequestState() {
        synchronized(lock) {
            if (!running || !sessionReady) {
                logLine("skip wear detector setup; session not ready")
                return
            }
            clearMessagesOfKindLocked("wear-detection-control")
            clearMessagesOfKindLocked("wear-query-control")
            val queryLeft = messageBuilder.faceclawWearQuery(true)
            val queryRight = messageBuilder.faceclawWearQuery(false)
            val enable = messageBuilder.setWearDetection(true)
            enable.onTimeout = MessageCallback { logLine("wear detection enable ack timeout") }
            pendingMessages.addFirst(queryLeft)
            pendingMessages.addFirst(queryRight)
            pendingMessages.addFirst(enable)
            logLine("queue wear detection enable + current-state query")
        }
        interruptibleSleep.interrupt()
    }

    /**
     * Start the BLE bandwidth benchmark: stream messageSize-byte no-op image
     * payloads for durationMs, keeping up to windowSize messages awaiting ack
     * at once, then leave the results for getBandwidthBenchmarkStatus().
     * Returns false when a run is already active or the image path is not
     * ready. The duration clock starts at the first benchmark write, so
     * traffic already queued ahead of the run doesn't count against it.
     */
    fun startBandwidthBenchmark(messageSize: Int, windowSize: Int, durationMs: Int): Boolean {
        return startBandwidthBenchmarkWithLinkMode(messageSize, windowSize, durationMs, 0)
    }

    // 0: current link; 1: re-request HIGH; 2: request 2M; 3: both.
    fun startBandwidthBenchmarkWithLinkMode(messageSize: Int, windowSize: Int,
                                            durationMs: Int, linkMode: Int): Boolean {
        synchronized(lock) {
            if (benchmarkActive || !running || !sessionReady || !fixedLayoutCreated
                    || shutdownRequested || chargingMode) {
                logLine("skip bandwidth benchmark; already running or image path not ready")
                return false
            }
            benchmarkMessageSize = Math.max(2, Math.min(messageSize, ConnectionOptions.IMAGE_FRAGMENT_SIZE))
            benchmarkWindowSize = Math.max(1, Math.min(windowSize, BENCHMARK_MAX_WINDOW))
            benchmarkDurationMs = Math.max(1_000, durationMs)
            benchmarkLinkMode = linkMode and 3
            benchmarkLinkPending = true
            benchmarkReadyAtMs = Long.MAX_VALUE
            benchmarkStartAtMs = 0
            benchmarkDeadlineAtMs = Long.MAX_VALUE
            benchmarkLastAckAtMs = 0
            benchmarkEndAtMs = 0
            benchmarkMessagesSent = 0
            benchmarkMessagesAcked = 0
            benchmarkTimeouts = 0
            benchmarkPayloadBytesAcked = 0
            benchmarkWireBytesAcked = 0
            benchmarkAborted = false
            benchmarkActive = true
            logLine("bandwidth benchmark start: size=" + benchmarkMessageSize
                + "B window=" + benchmarkWindowSize + " duration=" + benchmarkDurationMs
                + "ms linkMode=" + benchmarkLinkMode)
        }
        interruptibleSleep.interrupt()
        return true
    }

    /**
     * Cancel an in-progress benchmark (benchmark page closed). Queued no-op
     * messages are dropped; in-flight ones drain through their normal acks.
     */
    fun cancelBandwidthBenchmark() {
        synchronized(lock) {
            if (!benchmarkActive) {
                return
            }
            clearMessagesOfKindLocked("bandwidth")
            finishBenchmarkLocked(true, "cancelled")
        }
        interruptibleSleep.interrupt()
    }

    /** Status/results of the current or most recent benchmark run, as JSON. */
    fun getBandwidthBenchmarkStatus(): String {
        synchronized(lock) {
            val state = if (benchmarkActive)
                (if (benchmarkStartAtMs == 0L) "starting" else "running")
            else
                (if (benchmarkEndAtMs != 0L) "done" else "idle")
            val end = if (benchmarkActive) SystemClock.elapsedRealtime() else benchmarkEndAtMs
            val elapsed = if (benchmarkStartAtMs == 0L) 0L else Math.max(0L, end - benchmarkStartAtMs)
            try {
                val status = org.json.JSONObject()
                status.put("state", state)
                status.put("messageSize", benchmarkMessageSize)
                status.put("windowSize", benchmarkWindowSize)
                status.put("linkMode", benchmarkLinkMode)
                status.put("elapsedMs", elapsed)
                status.put("messagesSent", benchmarkMessagesSent)
                status.put("messagesAcked", benchmarkMessagesAcked)
                status.put("timeouts", benchmarkTimeouts)
                status.put("payloadBytesAcked", benchmarkPayloadBytesAcked)
                status.put("wireBytesAcked", benchmarkWireBytesAcked)
                status.put("aborted", benchmarkAborted)
                return status.toString()
            } catch (e: org.json.JSONException) {
                return "{\"state\":\"idle\"}"
            }
        }
    }

    /** Pending + in-flight benchmark no-op messages. */
    private fun benchmarkOutstandingLocked(): Int {
        var count = 0
        for (message in pendingMessages) {
            if ("bandwidth" == message.kind) count++
        }
        for (message in inFlightMessages) {
            if ("bandwidth" == message.kind) count++
        }
        return count
    }

    /**
     * Keep the benchmark stream fed: top the pending queue up so the send
     * window never starves, stop enqueueing once the run expires (or a message
     * times out), and finish the run when the last outstanding message drains.
     */
    private fun maintainBenchmarkLocked(now: Long) {
        if (!sessionReady || !fixedLayoutCreated || shutdownRequested) {
            finishBenchmarkLocked(true, "session no longer ready")
            return
        }
        if (benchmarkLinkPending || now < benchmarkReadyAtMs) {
            return
        }
        if (benchmarkAborted || now >= benchmarkDeadlineAtMs) {
            // The run is over: drop queued-but-unsent no-ops (sending them
            // would stretch the run past its deadline) and finish once the
            // in-flight tail has acked or timed out.
            val pendingIterator = pendingMessages.iterator()
            while (pendingIterator.hasNext()) {
                val queued = pendingIterator.next()
                if ("bandwidth" == queued.kind) {
                    pendingIterator.remove()
                    magicPool.release(queued.sid, queued.magic, queued.label, "benchmark over")
                }
            }
            if (benchmarkOutstandingLocked() == 0) {
                finishBenchmarkLocked(false, "complete")
            }
            return
        }
        // One more than the window so a fresh message is always ready to write
        // the moment an ack frees a slot.
        var outstanding = benchmarkOutstandingLocked()
        while (outstanding <= benchmarkWindowSize) {
            enqueueBenchmarkMessageLocked()
            outstanding++
        }
    }

    private fun finishBenchmarkLocked(aborted: Boolean, reason: String) {
        if (!benchmarkActive) {
            return
        }
        benchmarkActive = false
        benchmarkAborted = benchmarkAborted or aborted
        // Prefer the last ack as the end time so drain lag after the deadline
        // doesn't dilute the throughput figure.
        benchmarkEndAtMs = if (benchmarkLastAckAtMs != 0L) benchmarkLastAckAtMs else SystemClock.elapsedRealtime()
        logLine("bandwidth benchmark " + (if (benchmarkAborted) "aborted" else "finished") + " (" + reason + "): "
            + benchmarkMessagesAcked + "/" + benchmarkMessagesSent + " acked, "
            + benchmarkPayloadBytesAcked + "B payload, " + benchmarkTimeouts + " timeouts")
    }

    private fun enqueueBenchmarkMessageLocked() {
        // Fresh bytes per message: the transport's persistent compression history
        // would compress even a random payload if we reused it across the run.
        val payload = ByteArray(benchmarkMessageSize)
        benchmarkRandom.nextBytes(payload)
        payload[0] = CFW_MSG_DIAGNOSTICS.toByte()             // CFW diagnostic-control mode...
        payload[1] = 0x7f.toByte()   // ...with an unused sub-op: acked, no effect
        val message = messageBuilder.imagePayload(
            "bandwidth",
            DASHBOARD_TILE,
            nextMapSessionId(),
            payload,
            "bandwidth no-op " + payload.size + "B",
            connectionOptions.sendImagesToLeft)
        val payloadBytes = payload.size
        // Logical custom-message bytes; excludes length tag and packet framing.
        val wireBytes = message.message.size
        message.onSent = MessageCallback {
            benchmarkMessagesSent++
            if (benchmarkStartAtMs == 0L) {
                benchmarkStartAtMs = SystemClock.elapsedRealtime()
                benchmarkDeadlineAtMs = benchmarkStartAtMs + benchmarkDurationMs
            }
        }
        message.onAck = MessageCallback {
            val ackedAtMs = SystemClock.elapsedRealtime()
            benchmarkMessagesAcked++
            benchmarkPayloadBytesAcked += payloadBytes
            benchmarkWireBytesAcked += wireBytes
            benchmarkLastAckAtMs = ackedAtMs
            // No-op payloads ride the image path, so the firmware resets its
            // heartbeat timer on them just like real image messages.
            lastHeartbeatAckedAtMs = ackedAtMs
        }
        message.onTimeout = MessageCallback {
            benchmarkTimeouts++
            benchmarkAborted = true
            logLine("bandwidth benchmark ack timeout")
        }
        pendingMessages.addLast(message)
    }

    fun addImuListener(listener: FaceclawImuListener?) {
        if (listener != null) {
            imuListeners.add(listener)
        }
    }

    fun removeImuListener(listener: FaceclawImuListener?) {
        if (listener != null) {
            imuListeners.remove(listener)
        }
    }

    fun addAmbientLightListener(listener: FaceclawAmbientLightListener?) {
        if (listener != null) {
            ambientLightListeners.add(listener)
        }
    }

    fun removeAmbientLightListener(listener: FaceclawAmbientLightListener?) {
        if (listener != null) {
            ambientLightListeners.remove(listener)
        }
    }

    private fun emitAmbientLight(body: ByteArray) {
        if (ambientLightListeners.isEmpty()) {
            return
        }
        val copy = Arrays.copyOf(body, body.size)
        mainHandler.post {
            for (alsListener in ambientLightListeners) {
                try {
                    alsListener.onAmbientLight(copy)
                } catch (t: Throwable) {
                    Log.w(TAG, "ambient light listener failed", t)
                }
            }
        }
    }

    /** Request one CFW ambient-light report (image-handler mode 16 op 0). */
    fun queryAmbientLight() {
        synchronized(lock) {
            enqueueAmbientLightControlLocked(byteArrayOf(CFW_MSG_AMBIENT_LIGHT.toByte(), 0.toByte()), "als query", false)
        }
        interruptibleSleep.interrupt()
    }

    /**
     * Start or stop CFW passive light-sensor polling (image-handler mode 16
     * ops 1/2). While polling, the firmware reads its OPT3001 every intervalMs
     * (clamped 100..5000 by the firmware), never steps the panel brightness
     * itself, and pushes a field-105 report when the reading moved by at least
     * minDelta or heartbeatMs elapsed. bindToLease stops polling automatically
     * when the Faceclaw framebuffer lease is released or lapses. Starting is
     * idempotent and re-opens the sensor if the stock firmware closed it.
     */
    fun setAmbientLightPolling(enable: Boolean, intervalMs: Int, minDelta: Int,
                               heartbeatMs: Int, bindToLease: Boolean) {
        val payload = if (enable)
            byteArrayOf(
                CFW_MSG_AMBIENT_LIGHT.toByte(),
                1.toByte(),
                (if (bindToLease) 1 else 0).toByte(),
                (intervalMs and 0xff).toByte(),
                ((intervalMs shr 8) and 0xff).toByte(),
                (minDelta and 0xff).toByte(),
                ((minDelta shr 8) and 0xff).toByte(),
                (heartbeatMs and 0xff).toByte(),
                ((heartbeatMs shr 8) and 0xff).toByte(),
            )
        else
            byteArrayOf(CFW_MSG_AMBIENT_LIGHT.toByte(), 2.toByte())
        synchronized(lock) {
            clearMessagesOfKindLocked("als-control")
            enqueueAmbientLightControlLocked(payload, "als polling " + (if (enable) "start" else "stop"), true)
        }
        interruptibleSleep.interrupt()
    }

    private fun enqueueAmbientLightControlLocked(payload: ByteArray, label: String, priority: Boolean) {
        if (!running || !sessionReady || shutdownRequested || !fixedLayoutCreated) {
            logLine("skip $label; display path not ready")
            return
        }
        val message = messageBuilder.imagePayload(
            "als-control",
            DASHBOARD_TILE,
            nextMapSessionId(),
            payload,
            label,
            connectionOptions.sendImagesToLeft)
        message.onTimeout = MessageCallback { logLine("$label ack timeout") }
        if (priority) pendingMessages.addFirst(message)
        else pendingMessages.addLast(message)
        logLine("queue $label")
    }

    fun addMicStatusListener(listener: FaceclawMicStatusListener?) {
        if (listener != null) {
            micStatusListeners.add(listener)
        }
    }

    fun removeMicStatusListener(listener: FaceclawMicStatusListener?) {
        if (listener != null) {
            micStatusListeners.remove(listener)
        }
    }

    private fun emitMicStatus(body: ByteArray, address: String) {
        if (micStatusListeners.isEmpty()) {
            return
        }
        val arm = if (address.equals(leftAddress, ignoreCase = true)) "L"
            else if (address.equals(rightAddress, ignoreCase = true)) "R" else "?"
        val copy = Arrays.copyOf(body, body.size)
        mainHandler.post {
            for (micListener in micStatusListeners) {
                try {
                    micListener.onMicStatus(copy, arm)
                } catch (t: Throwable) {
                    Log.w(TAG, "mic status listener failed", t)
                }
            }
        }
    }

    /**
     * Queue a CFW mic_control record (['M','C',ver,op,...]) as a settings
     * field-103 write to both temples, or to a single one. Fire-and-forget:
     * the firmware answers with a field-104 status notify per temple, which
     * arrives through addMicStatusListener.
     */
    fun sendFaceclawMicControl(record: ByteArray?, label: String, rightTemple: Boolean, leftTemple: Boolean) {
        if (record == null || record.size < 4) {
            return
        }
        synchronized(lock) {
            if (!running || !sessionReady) {
                logLine("skip mic control ($label); session not ready")
                return
            }
            if (rightTemple) {
                pendingMessages.addLast(messageBuilder.faceclawMicControl(record, label, false))
            }
            if (leftTemple) {
                pendingMessages.addLast(messageBuilder.faceclawMicControl(record, label, true))
            }
            logLine("queue mic control $label")
        }
        interruptibleSleep.interrupt()
    }

    /**
     * Forward render-characteristic audio packets to the listener WITHOUT
     * sending the stock EvenHub audio-control enable. Used for the CFW
     * mic_control streaming path, where capture is armed through settings
     * field 103 and the temples emit 'SM' frames on the same characteristic
     * that stock mono LC3 uses. Returns false when no session is up.
     */
    fun startG2AudioForwarding(listener: FaceclawAudioPacketListener?): Boolean {
        if (listener == null) {
            throw IllegalArgumentException("listener is required")
        }
        synchronized(lock) {
            if (!running || !sessionReady || shutdownRequested) {
                logLine("skip G2 audio forwarding; session not ready")
                return false
            }
            audioPacketListener = listener
            audioCaptureActive = true
            logLine("G2 audio forwarding enabled")
        }
        return true
    }

    fun stopG2AudioForwarding() {
        synchronized(lock) {
            audioPacketListener = null
            audioCaptureActive = false
            logLine("G2 audio forwarding disabled")
        }
    }

    /**
     * Subscribe to compass events. Callbacks are delivered on the Looper of
     * the thread that registered (falling back to the main thread), so app
     * worker isolates can listen without a cross-thread hop into their JS.
     */
    fun addCompassListener(listener: FaceclawCompassListener?) {
        if (listener == null) {
            return
        }
        val looper = Looper.myLooper()
        val handler = if (looper != null) Handler(looper) else mainHandler
        compassSubscriptions.add(CompassSubscription(listener, handler))
    }

    fun removeCompassListener(listener: FaceclawCompassListener?) {
        if (listener == null) {
            return
        }
        for (subscription in compassSubscriptions) {
            if (subscription.listener === listener) {
                compassSubscriptions.remove(subscription)
            }
        }
    }

    /** Set the compositor's output frame size. Call before configuring surfaces. */
    fun configureCompositorScreen(width: Int, height: Int) {
        compositor.configureScreen(width, height)
    }

    /**
     * The current composited screen as a phone-UI preview bitmap, or null
     * before any surface has been configured. Built from the compositor so
     * the preview reflects every surface (chrome + whichever app is
     * foreground), including worker-app frames the TS side never sees.
     */
    fun getCompositePreviewBitmap(brightenGamma: Double): android.graphics.Bitmap? {
        return getCompositePreviewBitmap(brightenGamma, false)
    }

    /** As above; `green` renders the preview green-on-black (Settings > Phone display > Preview color). */
    fun getCompositePreviewBitmap(brightenGamma: Double, green: Boolean): android.graphics.Bitmap? {
        val composite = compositor.previewComposite() ?: return null
        return PreviewBitmapUtil.fromGray(
                java.nio.ByteBuffer.wrap(composite.gray), composite.width, composite.height, brightenGamma, green)
    }

    /** Save the current composite as a 4-bit grayscale PNG; returns the path or "". */
    @Throws(java.io.IOException::class)
    fun saveCompositePngScreenshot(): String {
        val composite = compositor.previewComposite() ?: return ""
        return ScreenshotUtil.savePngScreenshot(appContext, composite.gray, composite.width, composite.height)
    }

    /**
     * Save the current composite cropped to the given screen rect (the region
     * the shell says is actually occupied). The rect is clamped to the screen;
     * a degenerate rect falls back to the full screen.
     */
    @Throws(java.io.IOException::class)
    fun saveCompositePngScreenshot(cropX: Int, cropY: Int, cropWidth: Int, cropHeight: Int): String {
        val composite = compositor.previewComposite() ?: return ""
        val x = Math.max(0, cropX)
        val y = Math.max(0, cropY)
        val width = Math.min(composite.width - x, cropWidth - (x - cropX))
        val height = Math.min(composite.height - y, cropHeight - (y - cropY))
        if (width <= 0 || height <= 0 || (x == 0 && y == 0 && width == composite.width && height == composite.height)) {
            return ScreenshotUtil.savePngScreenshot(appContext, composite.gray, composite.width, composite.height)
        }
        val cropped = ByteArray(width * height)
        for (row in 0 until height) {
            System.arraycopy(composite.gray, (y + row) * composite.width + x, cropped, row * width, width)
        }
        return ScreenshotUtil.savePngScreenshot(appContext, cropped, width, height)
    }

    /** Begin collecting composite frames for an animated-GIF screen recording. */
    fun startScreenRecording() {
        screenRecorder = GifScreenRecorder()
    }

    /** Capture the current composite into the active recording; no-op when idle. */
    fun recordScreenFrame() {
        val recorder = screenRecorder ?: return
        val composite = compositor.previewComposite() ?: return
        recorder.addFrame(composite.gray, composite.width, composite.height, System.currentTimeMillis())
    }

    /** Finish the recording and save it as an animated GIF; returns the path or "". */
    @Throws(java.io.IOException::class)
    fun stopScreenRecording(): String {
        val recorder = screenRecorder
        screenRecorder = null
        if (recorder == null) {
            return ""
        }
        if (recorder.isOverflowed()) {
            logLine("screen recording hit its frame cap; the tail was dropped")
        }
        return recorder.save(appContext)
    }

    /**
     * Show or hide a compositor surface, immediately submitting the resulting
     * frame. Recompositing here (rather than waiting for the next surface
     * update) is what makes a just-foregrounded window's retained frame
     * actually appear — otherwise a static window (e.g. the terminal hub) whose
     * frame landed while briefly hidden would stay blank until its next repaint.
     */
    fun setSurfaceVisible(id: String, visible: Boolean) {
        // Its own frame: this recomposite is a real screen update with real
        // latency, and without one it would show up in other frames' logs only
        // as an anonymous "superseded by frame#0".
        val frameId = FrameTimings.getInstance().startFrame(
                "compositor:visible $id=$visible")
        compositor.setSurfaceVisible(id, visible)
        val composite = compositor.composite()
        val packed = BmpUtil.pack4bppFromGray8(composite.screenGray, composite.width, composite.height)
        storeDesiredComposite(composite, packed, 0, frameId)
    }

    /**
     * Blank (screen off) or unblank the composited output, immediately
     * submitting the resulting frame. Retained surface state is untouched, so
     * unblanking restores the previous screen content without repaints.
     */
    fun setScreenBlanked(blanked: Boolean) {
        val frameId = FrameTimings.getInstance().startFrame(
                "compositor:" + (if (blanked) "blank" else "unblank"))
        compositor.setBlanked(blanked)
        val composite = compositor.composite()
        val packed = BmpUtil.pack4bppFromGray8(composite.screenGray, composite.width, composite.height)
        storeDesiredComposite(composite, packed, 0, frameId)
    }

    /**
     * Create or reconfigure a compositor surface. transparency is one of the
     * SurfaceCompositor.TRANSPARENCY_* constants. Geometry changes take effect
     * when the next frame is submitted.
     */
    fun configureSurface(id: String?, x: Int, y: Int, width: Int, height: Int, zOrder: Int, transparency: Int) {
        compositor.configureSurface(id, x, y, width, height, zOrder, transparency)
    }

    fun removeSurface(id: String) {
        compositor.removeSurface(id)
    }

    /** Stage an immutable shell snapshot alongside the retained app screen. */
    fun submitShellScene(bytes: java.nio.ByteBuffer, paintMs: Int, frameId: Int) {
        compositor.setShellScene(AndroidByteReader(bytes))
        val composite = compositor.composite()
        storeDesiredComposite(composite, BmpUtil.pack4bppFromGray8(composite.screenGray, composite.width, composite.height), paintMs, frameId)
    }

    /** Legacy compositor dimming for callers without a shell scene. */
    fun setUnderlayDim(belowZOrder: Int, factor256: Int) {
        compositor.setUnderlayDim(belowZOrder, factor256)
    }

    /**
     * Apply an update to one compositor surface and submit the recomposited
     * screen as the desired frame. The update covers the rect (rectX, rectY,
     * rectWidth, rectHeight) in surface-local coordinates; contentFingerprint
     * identifies the surface's full content after the update.
     *
     * pixels8bpp arrives as a ByteBuffer because NativeScript marshals a JS
     * ArrayBuffer to one without the per-element bridge copy that a byte[]
     * parameter would need (~150ms for a full frame).
     */
    fun submitSurfaceFrame(
            pixels8bpp: java.nio.ByteBuffer,
            surfaceId: String,
            rectX: Int,
            rectY: Int,
            rectWidth: Int,
            rectHeight: Int,
            contentFingerprint: String?,
            paintMs: Int,
            frameId: Int
    ) {
        submitSurfaceFrame(pixels8bpp, surfaceId, rectX, rectY, rectWidth, rectHeight,
                contentFingerprint, paintMs, frameId, null)
    }

    /**
     * As above, with the frame's glyph draws (see SurfaceCompositor's glyph
     * overload for the buffer format): the surface's full text content as
     * structured draws, letting the resource-cache planner ship glyphs as
     * on-glasses cached draws instead of pixels. Null when the submitter has
     * no glyph metadata; the pixels alone remain fully correct.
     */
    fun submitSurfaceFrame(
            pixels8bpp: java.nio.ByteBuffer,
            surfaceId: String,
            rectX: Int,
            rectY: Int,
            rectWidth: Int,
            rectHeight: Int,
            contentFingerprint: String?,
            paintMs: Int,
            frameId: Int,
            glyphs: java.nio.ByteBuffer?
    ) {
        Log.i(TAG, "Received an updated frame for surface $surfaceId")
        FrameTimings.getInstance().log(frameId, "surface " + surfaceId + " updated rect="
                + rectWidth + "x" + rectHeight + "+" + rectX + "+" + rectY
                + (if (glyphs == null) " (no glyph draws)" else ""))
        FrameTimings.getInstance().spanStart(frameId, "composite")
        val composite = compositor.applyAndComposite(
                surfaceId, AndroidByteReader(pixels8bpp), rectX, rectY, rectWidth, rectHeight, contentFingerprint,
                if (glyphs == null) null else AndroidByteReader(glyphs))
        FrameTimings.getInstance().spanEnd(frameId, "composite")
        // Pack the composited 8bpp buffer down to the headerless 4bpp frame
        // format the wire planners consume; BMP framing is added later only for
        // the uncompressed fallback.
        FrameTimings.getInstance().spanStart(frameId, "pack-4bpp")
        val packed = BmpUtil.pack4bppFromGray8(composite.screenGray, composite.width, composite.height)
        FrameTimings.getInstance().spanEnd(frameId, "pack-4bpp")
        storeDesiredComposite(composite, packed, paintMs, frameId)
    }

    /** Store a composite as the desired frame unless a newer one won the race. */
    private fun storeDesiredComposite(composite: SurfaceCompositor.Composite, packed: ByteArray, paintMs: Int, frameId: Int) {
        var supersededFrameId = 0
        var stale = false
        synchronized(desiredTilesLock) {
            if (composite.seq <= lastStoredCompositeSeq) {
                // A concurrent submission composited after us and stored first;
                // its composite already includes this surface update.
                stale = true
            } else {
                lastStoredCompositeSeq = composite.seq
                supersededFrameId = desiredFrameId
                desiredPacked = packed
                desiredWidth = composite.width
                desiredHeight = composite.height
                desiredFingerprint = composite.fingerprint
                desiredPaintMs = paintMs
                desiredFrameId = frameId
                desiredDraws = composite.draws
                desiredShellScene = composite.shellScene
            }
        }
        if (stale) {
            finishFrame(frameId, "discarded: composite superseded before store")
            return
        }
        if (supersededFrameId != 0 && supersededFrameId != frameId) {
            finishFrame(supersededFrameId, "discarded: superseded by frame#$frameId before send")
        }
        FrameTimings.getInstance().log(frameId, "image submitted as desired frame")
        interruptibleSleep.interrupt()
    }

    /**
     * Play a tone sequence via CFW load_image_z mode 5 kind 4. The payload is
     * the complete wire buffer ([5][4][nSteps][freqLo,freqHi,duty,msLo,msHi]*n,
     * up to 48 steps), built on the TS side; it rides the arbitrary-payload
     * image path like the other mode-5 controls.
     */
    fun playBuzzerSequence(payload: java.nio.ByteBuffer?) {
        synchronized(lock) {
            if (!running || !sessionReady || !fixedLayoutCreated) {
                logLine("skip buzzer sequence; session not ready")
                return
            }
            val bytes = ByteArray(if (payload == null) 0 else payload.remaining())
            if (payload != null) {
                payload.get(bytes)
            }
            if (bytes.size < 3) {
                logLine("skip buzzer sequence; empty payload")
                return
            }
            val message = messageBuilder.imagePayload(
                DASHBOARD_TILE,
                nextMapSessionId(),
                bytes,
                "buzzer sequence " + bytes.size + "B",
                connectionOptions.sendImagesToLeft
            )
            message.onTimeout = MessageCallback {
                handleTransportFailure("buzzer sequence ack timeout")
            }
            pendingMessages.addLast(message)
            logLine("queue " + message.label)
        }
        interruptibleSleep.interrupt()
    }

    fun sendShutdown(exitMode: Int): Boolean {
        return sendShutdownInternal(exitMode, true)
    }

    /**
     * Send CFW image-handler mode 11 after quiescing normal traffic. A successful
     * return means the cleanup was ACKed and no later Faceclaw message should be
     * emitted before closing BLE. Unsupported/older CFWs return false so callers
     * can use the legacy shutdown-and-lease-release path.
     */
    fun sendCfwCleanup(): Boolean {
        val magic: Int
        synchronized(lock) {
            if (cfwCleanupDelivered) {
                return true
            }
            if (!customFirmwareDetected || !running || !sessionReady
                    || shutdownRequested || !fixedLayoutCreated) {
                logLine("skip CFW cleanup; mode 11 unavailable or image path not ready")
                return false
            }

            /* Stop auto-renewals, heartbeats, image generation, and control
             * retries, then discard everything that has not reached BLE yet. */
            shutdownRequested = true
            lastCfwCleanupAckMagic = 0
            clearPendingMessagesLocked("CFW cleanup requested")
            logLine("quiescing transport for CFW cleanup")
        }
        interruptibleSleep.interrupt()

        /* WINDOW_SIZE can exceed one, so merely appending cleanup would allow it
         * to overlap previously-written image fragments. Wait until all of those
         * ACK or time out; shutdownRequested prevents the drive loop from adding
         * any fresh automatic traffic meanwhile. */
        val drainDeadline = SystemClock.elapsedRealtime() + CFW_CLEANUP_WAIT_MS
        synchronized(lock) {
            while (running && sessionReady && !inFlightMessages.isEmpty()) {
                val remaining = drainDeadline - SystemClock.elapsedRealtime()
                if (remaining <= 0) break
                try {
                    lock.wait(Math.min(remaining, 100L))
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }
            if (!running || !sessionReady || !inFlightMessages.isEmpty()) {
                shutdownRequested = false
                logLine("CFW cleanup could not drain prior traffic")
                return false
            }

            /* External producers are expected to be stopped by the caller, but
             * clear once more at the barrier so cleanup is definitely last. */
            clearPendingMessagesLocked("CFW cleanup barrier")
            val message = messageBuilder.cfwCleanup(
                DASHBOARD_TILE,
                nextMapSessionId(),
                connectionOptions.sendImagesToLeft
            )
            magic = message.magic
            message.onAck = MessageCallback {
                lastCfwCleanupAckMagic = message.magic
                cfwCleanupDelivered = true
                compassMaybeOn = false
                faceclawWakeLeaseEnabled = false
                logLine("CFW cleanup completed")
            }
            message.onTimeout = MessageCallback { logLine("CFW cleanup ack timeout") }
            pendingMessages.addLast(message)
            logLine("queue CFW cleanup")
        }
        interruptibleSleep.interrupt()

        val deadline = SystemClock.elapsedRealtime() + CFW_CLEANUP_WAIT_MS
        synchronized(lock) {
            while (running
                    && sessionReady
                    && lastCfwCleanupAckMagic != magic
                    && hasPendingOrInflightMagicLocked(magic)) {
                val remaining = deadline - SystemClock.elapsedRealtime()
                if (remaining <= 0) break
                try {
                    lock.wait(Math.min(remaining, 100L))
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }
            val acked = lastCfwCleanupAckMagic == magic
            if (!acked) shutdownRequested = false
            return acked
        }
    }

    /**
     * End the EvenHub page while retaining both arm GATT connections and all
     * notification subscriptions. A missed ACK is intentionally non-fatal:
     * reconnecting Bluetooth here would defeat the power-saving mode.
     */
    fun suspendEvenHubSession(): Boolean {
        // Ending the plugin task releases the fb lease, which frees the
        // on-glasses resource cache; forget it phone-side either way (a lost
        // ack may still have taken effect).
        synchronized(lock) {
            resourceCache.reset()
        }
        if (sendShutdownInternal(0, false)) {
            return true
        }
        synchronized(lock) {
            // A shutdown ACK can be lost even though the command took effect.
            // If the transport remains intentionally quiesced, callers still
            // need to remember to run the resume path on the next wake.
            return running && sessionReady && shutdownRequested
        }
    }

    /**
     * Start a fresh EvenHub plugin task on the existing BLE transport, then let
     * the session driver create the layout, warm up the image path, and send
     * the desired frame.
     */
    fun resumeEvenHubSession(): Boolean {
        var claimGeneration = 0
        synchronized(lock) {
            if (!running || !sessionReady || chargingMode) {
                logLine("skip EvenHub resume; transport not ready")
                return false
            }
            if (!shutdownRequested) {
                return true
            }
            if (faceclawWakePendingNonce >= 0
                    && hasPendingOrInflightKindLocked("wake-lease-control")) {
                claimGeneration = faceclawWakeControlGeneration
            }
            logLine("replaying session prelude for EvenHub resume")
        }

        // A custom double-tap wake has only a short unclaimed fail-open
        // deadline. Let the worker put CLAIM on both arms before the direct
        // prelude write begins.
        if (claimGeneration != 0) {
            waitForFaceclawWakeControlDelivery(claimGeneration, 500)
        }

        try {
            // Empty-name Cmd=9 tears down the whole plugin task, not just its
            // image container. Re-run the launch prelude before Cmd=0 CREATE.
            sendPrelude(true)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            handleTransportFailure("EvenHub resume prelude interrupted")
            return false
        } catch (t: Throwable) {
            logLine("EvenHub resume prelude failed: " + safeMessage(t))
            handleTransportFailure("EvenHub resume prelude failed")
            return false
        }

        synchronized(lock) {
            if (!running || !sessionReady || chargingMode) {
                return false
            }
            shutdownRequested = false
            fixedLayoutCreated = false
            startupProbePending = false
            audioCaptureActive = false
            clearAllMessagesPreservingWakeLeaseLocked("EvenHub resume")
            displayedFingerprint = ""
            imageRetryAfterMs = 0
            lastHeartbeatSentAtMs = 0
            lastHeartbeatAckedAtMs = 0
            logLine("EvenHub session resume requested")
        }
        interruptibleSleep.interrupt()
        return true
    }

    private fun sendShutdownInternal(exitMode: Int, reconnectOnTimeout: Boolean): Boolean {
        val magic: Int
        val startedAtMs = SystemClock.elapsedRealtime()
        synchronized(lock) {
            if (!running || !sessionReady) {
                logLine("skip shutdown; session not ready")
                return false
            }
            if (shutdownRequested) {
                return true
            }
            shutdownRequested = true
            // Magic values wrap, so an ACK from a much older suspend must not
            // satisfy this request after enough sleep/wake cycles.
            lastShutdownAckMagic = 0
            clearPendingMessagesLocked("shutdown requested")
            val message = messageBuilder.shutdown(exitMode)
            magic = message.magic
            message.onAck = MessageCallback {
                lastShutdownAckMagic = message.magic
                fixedLayoutCreated = false
                displayedFingerprint = ""
            }
            message.onTimeout = MessageCallback {
                if (reconnectOnTimeout) {
                    handleTransportFailure("shutdown ack timeout")
                } else {
                    logLine("EvenHub shutdown ack timeout; keeping BLE connected")
                }
            }
            pendingMessages.addFirst(message)
            logLine("queue shutdown")
            // The stock compass keeps the magnetometer sampling independently of
            // the plugin task, so ending the page does not stop it. Force a
            // disable ahead of the shutdown command whenever it may be running:
            // this also covers a disable that was wiped by the queue flush above
            // or whose ack was lost, and the charging-mode/exit paths where the
            // Compass window never got a chance to release it.
            if (compassMaybeOn && fixedLayoutCreated) {
                enqueueCompassControlLocked(true, false)
            }
        }
        interruptibleSleep.interrupt()

        val ackDeadline = SystemClock.elapsedRealtime() + ConnectionOptions.ACK_TIMEOUT_MS + 500
        synchronized(lock) {
            while (running
                    && sessionReady
                    && lastShutdownAckMagic != magic
                    && lastShutdownExitAtMs < startedAtMs
                    && hasPendingOrInflightMagicLocked(magic)) {
                val remaining = ackDeadline - SystemClock.elapsedRealtime()
                if (remaining <= 0) {
                    break
                }
                try {
                    lock.wait(Math.min(remaining, 100L))
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }
            val acked = lastShutdownAckMagic == magic
            if (acked) {
                val exitDeadline = SystemClock.elapsedRealtime() + ConnectionOptions.ACK_TIMEOUT_MS + 500
                while (running && sessionReady && lastShutdownExitAtMs < startedAtMs) {
                    val remaining = exitDeadline - SystemClock.elapsedRealtime()
                    if (remaining <= 0) {
                        break
                    }
                    try {
                        lock.wait(Math.min(remaining, 100L))
                    } catch (e: InterruptedException) {
                        Thread.currentThread().interrupt()
                        break
                    }
                }
            }
            return acked || lastShutdownExitAtMs >= startedAtMs
        }
    }

    private fun waitForAudioControlAck(magic: Int, operation: String): Boolean {
        val deadline = SystemClock.elapsedRealtime() + ConnectionOptions.ACK_TIMEOUT_MS + ConnectionOptions.WRITE_TIMEOUT_MS + 500
        synchronized(lock) {
            while (running && sessionReady && lastAudioControlAckMagic != magic && hasPendingOrInflightMagicLocked(magic)) {
                val remaining = deadline - SystemClock.elapsedRealtime()
                if (remaining <= 0) {
                    break
                }
                try {
                    lock.wait(Math.min(remaining, 100L))
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }
            val acked = lastAudioControlAckMagic == magic
            if (!acked) {
                if ("enable" == operation) {
                    audioPacketListener = null
                    audioCaptureActive = false
                }
                logLine("G2 mic $operation ack timeout")
            }
            return acked
        }
    }


    override fun run() {
        logLine(String.format(Locale.US, "communicator start R=%s L=%s ring=%s", rightAddress, leftAddress, ringAddress))
        while (true) {
            try {
                if (!running) {
                    Log.w(TAG, "Exiting event looop")
                    break
                }
                emitPhoneLockStateIfChanged(false)
                if (!sessionReady) {
                    if (reconnectHalted) {
                        interruptibleSleep.sleep(ConnectionOptions.IDLE_SLEEP_MS.toLong())
                        continue
                    }
                    val now = SystemClock.elapsedRealtime()
                    if (now < reconnectAfterMs) {
                        interruptibleSleep.sleep(Math.min(ConnectionOptions.IDLE_SLEEP_MS.toLong(), reconnectAfterMs - now))
                        continue
                    }
                    Log.w(TAG, "Attempting to connect")
                    connectLoopOnce()
                    continue
                }

                if (shouldAttemptRingConnect()) {
                    tryConnectRing("retry")
                    continue
                }

                val sleepMs = driveSession()
                if (sleepMs > 0) {
                    interruptibleSleep.sleep(sleepMs)
                }
            } catch (t: Throwable) {
                logLine("communicator loop error: " + safeMessage(t))
                handleTransportFailure("loop error")
            }
        }
        logLine("communicator stop")
    }

    override fun onNotification(address: String?, characteristicUuid: String?, data: ByteArray?) {
        if (address == null || characteristicUuid == null || data == null) {
            return
        }
        val uuid = characteristicUuid.lowercase(Locale.US)
        if (isDirectRingNotification(address, uuid)) {
            handleDirectRingNotification(uuid, data)
            return
        }
        if (BleProtocol.RENDER_NOTIFY_UUID == uuid) {
            handleRenderNotification(address, data)
            return
        }
        if (BleProtocol.NOTIFY_CHAR_UUID != uuid) {
            return
        }
        if (data.size >= 7 && (data[6].toInt() and 255) == CfwTransport.SID) {
            val acks = CfwTransport.parseAcks(data) ?: return
            synchronized(lock) {
                lastIncomingAtMs = SystemClock.elapsedRealtime()
                for (ack in acks) {
                    for (message in inFlightMessages) {
                        val ingress = if (message.isLeftArmMessage) leftAddress else rightAddress
                        if (message.sid == CfwTransport.SID && address.equals(ingress, ignoreCase = true) && message.magic == ack.streamId) {
                            message.acceptCfwAck(ack)
                            Log.i(TAG, "CFW " + (if (ack.nack) "NACK" else "ACK") + " id=" + ack.streamId
                                    + " ordinal=" + ack.messageId + " lens=" + ack.lens + " txseq=" + (data[2].toInt() and 255)
                                    + " redundant=" + (ack !== acks[0])
                                    + " size=" + ack.size + " crc=" + ack.checksum
                                    + " expected=" + message.message.size + "/" + message.cfwChecksum
                                    + " ackedLenses=" + message.cfwAckLenses
                                    + " ageMs=" + (lastIncomingAtMs - message.sentAtMs))
                            message.ackPayload = Arrays.copyOf(data, data.size)
                            break
                        }
                    }
                }
                drainCfwAcknowledgementsLocked()
            }
            interruptibleSleep.interrupt()
            return
        }
        Log.d(TAG, "onNotification: address=" + address + " characteristicUuid=" + characteristicUuid + " data.length=" + data.size)
        val frame = BleProtocol.parseFrame(data)
        val decodedWearState = BleProtocol.parseWearState(frame)
        val compassEvent = if (address.equals(rightAddress, ignoreCase = true))
            BleProtocol.parseCompassEvent(frame)
        else
            null
        var emitWearState = false
        var event: G2Event? = null
        synchronized(lock) {
            lastIncomingAtMs = SystemClock.elapsedRealtime()
            if (decodedWearState >= 0 && decodedWearState != wearState) {
                wearState = decodedWearState
                emitWearState = true
            }
            var faceclawWakeNotification = false
            if (shutdownRequested
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING
                    && address.equals(rightAddress, ignoreCase = true)) {
                val wakeNonce = BleProtocol.parseFaceclawWakeEvent(frame.pb)
                if (wakeNonce >= 0) {
                    faceclawWakePendingNonce = wakeNonce
                    enqueueFaceclawWakeControlLocked(
                        BleProtocol.FACECLAW_WAKE_OP_CLAIM,
                        wakeNonce,
                        true
                    )
                    faceclawWakeNotification = true
                    lastConnectionOrInputAtMs = lastIncomingAtMs
                    // The event type says which gesture woke the glasses: TS
                    // gives a head-up the Glanceboard and a double tap the
                    // regular UI. The claim handshake is the same for both.
                    val headUp = BleProtocol.parseFaceclawWakeEventCode(frame.pb) ==
                        BleProtocol.FACECLAW_WAKE_EVENT_HEAD_UP
                    event = G2Event(
                        "display-wake",
                        "",
                        if (headUp) BleProtocol.EVENT_HEAD_UP else BleProtocol.EVENT_DOUBLE_CLICK,
                        0,
                        0
                    )
                    logLine("claimed deferred dashboard wake nonce=" + wakeNonce
                        + (if (headUp) " (head-up)" else ""))
                }
            }
            if (!faceclawWakeNotification
                    && shutdownRequested
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING
                    && address.equals(rightAddress, ignoreCase = true)) {
                // CFW idle-gesture forwarding (firmware revision 2+): with no
                // EvenHub page the stock display thread drops taps, long
                // presses and releases; the CFW reports them on the settings
                // sid while our wake lease is held. Deliver them as the
                // sys-events a live page would have produced, so TS treats a
                // sleep-time tap or hold exactly like one during soft sleep
                // (the Glanceboard).
                val gesture = BleProtocol.parseFaceclawGestureEvent(frame.pb)
                if (gesture != null) {
                    lastConnectionOrInputAtMs = lastIncomingAtMs
                    event = G2Event("sys-event", "", gesture.eventType, gesture.eventSource, 0)
                    logLine("idle gesture forwarded by CFW: type=" + gesture.eventType
                        + " source=" + gesture.eventSource)
                }
            }
            if (!faceclawWakeNotification
                    && event == null
                    && shutdownRequested
                    && address.equals(rightAddress, ignoreCase = true)
                    && BleProtocol.isDisplayWakeStateChange(frame)) {
                // With no EvenHub page, ring/arm double-taps are handled by the
                // stock display lifecycle and surface only as this state ping.
                // Translate it back into an input event so TS can wake the shell
                // and recreate the page.
                event = G2Event(
                    "display-wake",
                    "",
                    BleProtocol.EVENT_DOUBLE_CLICK,
                    0,
                    0
                )
            }
            if (!faceclawWakeNotification
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING) {
                // Mode-17 query notifications; settings READs are handled by
                // createBatteryQueryMessageLocked so headset/ring update together.
                if (address.equals(rightAddress, ignoreCase = true)
                        && (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT)) {
                    val ring = BleProtocol.parseRingBattery(frame.pb)
                    if (ring != null) {
                        ringBattery = ring.battery
                        ringCharging = ring.charging
                        emitBatteryState(headsetBattery, headsetCharging)
                    }
                }
                // CFW mic status (field 104) rides both standalone pushes and
                // settings read acks, from each temple on its own link.
                val micStatus = BleProtocol.parseFaceclawMicStatus(frame.pb)
                if (micStatus != null) {
                    emitMicStatus(micStatus, address)
                }
            }
            if (!faceclawWakeNotification
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING) {
                // CFW ambient-light report (field 105) from the master temple.
                val alsReport = BleProtocol.parseFaceclawAlsReport(frame.pb)
                if (alsReport != null) {
                    emitAmbientLight(alsReport)
                }
            }
            if (!faceclawWakeNotification
                    && decodedWearState < 0
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING) {
                // Device-initiated settings push. It carries a magic the glasses
                // chose, so it would otherwise fall through to resolveAckLocked,
                // match nothing, and be logged as an unexpected ack.
                val pushedSilentMode = BleProtocol.parseSilentModePush(frame.pb)
                if (pushedSilentMode >= 0) {
                    updateSilentModeLocked(pushedSilentMode > 0)
                    return
                }
            }
            if (!faceclawWakeNotification
                    && decodedWearState < 0
                    && frame.ok
                    && frame.msgSeq >= 0
                    && frame.flag != BleProtocol.FLAG_NOTIFY
                    && frame.flag != BleProtocol.FLAG_NOTIFY_ALT) {
                lastAckAtMs = lastIncomingAtMs
                resolveAckLocked(frame.sid, frame.msgSeq, frame.pb)
            }
            if (!faceclawWakeNotification
                    && event == null
                    && frame.ok
                    && address.equals(rightAddress, ignoreCase = true)
                    && (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT)) {
                var decoded = G2Event.decode(frame)
                if (decoded != null
                        && "sys-event" == decoded.kind
                        && decoded.eventType == BleProtocol.EVENT_HEAD_UP) {
                    // CFW forwards the IMU head-up while our page is on screen
                    // (soft sleep). Surface it as the same wake-only input the
                    // deferred head-up wake produces from a dark display.
                    decoded = G2Event("display-wake", "", BleProtocol.EVENT_HEAD_UP, decoded.eventSource, 0)
                    logLine("head-up forwarded by CFW while page on screen")
                }
                event = decoded
                if (decoded != null) {
                    // Pure IMU samples arrive continuously; don't let them count
                    // as user input (which would starve battery polling).
                    val pureImuSample = "sys-event" == decoded.kind
                        && decoded.eventType == BleProtocol.EVENT_IMU_DATA_REPORT
                    if (!pureImuSample) {
                        lastConnectionOrInputAtMs = lastIncomingAtMs
                    }
                    if ("list-click" == decoded.kind || "text-click" == decoded.kind) {
                        // Container-routed touchpad input reached us, so the
                        // firmware is dispatching input: silent mode is off,
                        // whether or not its end-of-silent push arrived.
                        updateSilentModeLocked(false)
                    }
                    if ("sys-event" == decoded.kind) {
                        if (decoded.eventType == BleProtocol.EVENT_FOREGROUND_EXIT || decoded.eventType == BleProtocol.EVENT_ABNORMAL_EXIT || decoded.eventType == BleProtocol.EVENT_SYSTEM_EXIT) {
                            if (shutdownRequested) {
                                lastShutdownExitAtMs = SystemClock.elapsedRealtime()
                            }
                            fixedLayoutCreated = false
                            displayedFingerprint = ""
                            clearAllMessagesLocked("firmware exit event")
                        }
                    }
                }
            }
        }
        interruptibleSleep.interrupt()
        if (emitWearState) {
            logLine(if (decodedWearState > 0) "wear state ON_HEAD" else "wear state OFF_HEAD")
            emitWearState(decodedWearState > 0)
        }
        if (compassEvent != null) {
            emitCompassEvent(compassEvent)
        }
        val finalEvent = event
        if (finalEvent != null) {
            if (finalEvent.hasImu) {
                emitImuData(finalEvent.imuX, finalEvent.imuY, finalEvent.imuZ, finalEvent.eventSource)
            }
            // A standalone IMU_DATA_REPORT is a sensor sample, not a gesture:
            // deliver it only to IMU listeners, skipping the input pipeline (and
            // its per-frame latency bookkeeping) to avoid flooding it.
            val pureImuSample = "sys-event" == finalEvent.kind
                && finalEvent.eventType == BleProtocol.EVENT_IMU_DATA_REPORT
            if (!pureImuSample) {
                val frameId = FrameTimings.getInstance().startFrame(
                    "input:" + finalEvent.kind + " type=" + finalEvent.eventType + " src=" + finalEvent.eventSource)
                FrameTimings.getInstance().log(frameId, "input event decoded from BLE notification")
                emitRingEvent(finalEvent, frameId)
            }
        }
    }

    private fun handleDirectRingNotification(characteristicUuid: String, data: ByteArray) {
        val decoded = FaceclawRingEventDecoder.decode(data)
        if (decoded == null) {
            Log.d(TAG, "direct ring notify ignored: characteristicUuid=" + characteristicUuid + " raw=" + hex(data))
            return
        }

        val event = decoded.event
        val arrivalMs = SystemClock.elapsedRealtime()
        synchronized(lock) {
            lastIncomingAtMs = arrivalMs
            lastConnectionOrInputAtMs = arrivalMs
        }
        logLine("direct ring " + decoded.label + " " + decoded.detail + " raw=" + hex(data))
        val frameId = FrameTimings.getInstance().startFrame("input:ring:" + decoded.label)
        FrameTimings.getInstance().log(frameId, "input event decoded from direct ring notification")
        emitRingEvent(event, frameId)
        interruptibleSleep.interrupt()
    }

    private fun handleRenderNotification(address: String, data: ByteArray) {
        val listenerToCall: FaceclawAudioPacketListener?
        val arrivalMs = SystemClock.elapsedRealtime()
        synchronized(lock) {
            lastIncomingAtMs = arrivalMs
            listenerToCall = if (audioCaptureActive) audioPacketListener else null
        }
        if (listenerToCall == null) {
            return
        }
        val arm = if (address.equals(leftAddress, ignoreCase = true)) "L" else if (address.equals(rightAddress, ignoreCase = true)) "R" else "?"
        try {
            listenerToCall.onAudioPacket(Arrays.copyOf(data, data.size), arm, arrivalMs)
        } catch (t: Throwable) {
            logLine("G2 mic packet listener failed: " + safeMessage(t))
        }
    }

    override fun onConnectionStateChange(address: String?, connected: Boolean) {
        synchronized(lock) {
            if (address == null) {
                return
            }
            if (isConfiguredRingAddress(address)) {
                ringConnected = connected
                ringNotificationsReady = false
                if (!connected) {
                    ringReconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RING_RECONNECT_DELAY_MS
                }
                logLine(if (connected) "direct ring BLE connected" else "direct ring BLE disconnected")
                return
            }
            if (address.equals(rightAddress, ignoreCase = true)) {
                rightConnected = connected
            } else if (address.equals(leftAddress, ignoreCase = true)) {
                leftConnected = connected
            } else {
                return
            }
            if (!connected) {
                sessionReady = false
                fixedLayoutCreated = false
                startupProbePending = false
                chargingMode = false
                audioCaptureActive = false
                audioPacketListener = null
                clearAllMessagesLocked("connection lost")
                displayedFingerprint = ""
                if (!reconnectHalted) {
                    reconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RECONNECT_DELAY_MS
                }
            }
        }
        interruptibleSleep.interrupt()
        if (connected) {
            setStateDisplay("connected", "Connected.")
        } else if (!reconnectHalted) {
            // While parked on a missing bond, keep the "unpaired" display: this
            // callback is just the teardown of the arm that did connect.
            setStateDisplay("connecting", "Connecting to the glasses...")
        }
    }

    @Throws(InterruptedException::class)
    private fun connectLoopOnce() {
        setStateDisplay("connecting", "Connecting to the glasses...")
        try {
            connectArm(rightAddress, true)
            connectArm(leftAddress, true)
            if (!sleepDuringConnectSettling(800)) {
                return
            }
            authenticateArms()
            sendPrelude()

            synchronized(lock) {
                sessionReady = true
                // A fresh transport prelude always starts an active EvenHub
                // lifecycle, even if the previous connection dropped while
                // its page was intentionally suspended.
                shutdownRequested = false
                fixedLayoutCreated = false
                clearAllMessagesLocked("session ready")
                displayedFingerprint = ""
                lastAckAtMs = SystemClock.elapsedRealtime()
                lastIncomingAtMs = lastAckAtMs
                lastConnectionOrInputAtMs = lastAckAtMs
                lastSessionReadyAtMs = lastAckAtMs
                lastBatteryRefreshAtMs = 0
                imageRetryAfterMs = 0
                lastHeartbeatSentAtMs = 0
                lastHeartbeatAckedAtMs = 0
                consecutiveAckTimeouts = 0
                lastAudioControlAckMagic = 0
                audioCaptureActive = false
                faceclawWakePendingNonce = -1
                cfwCleanupDelivered = false
                for (transport in cfwTransports) transport.reset()
                lastCfwCleanupAckMagic = 0
                lastFaceclawWakeLeaseQueuedAtMs = 0
                lastFaceclawFramebufferLeaseQueuedAtMs = 0
                enqueueFaceclawFramebufferControlLocked(
                    BleProtocol.FACECLAW_FB_OP_ACQUIRE,
                    true
                )
                if (faceclawWakeLeaseEnabled) {
                    enqueueFaceclawWakeControlLocked(
                        BleProtocol.FACECLAW_WAKE_OP_ACQUIRE,
                        0,
                        true
                    )
                }
            }
            setStateDisplay("connected", "Connected.")
            logLine("session ready")
            synchronized(lock) {
                // Query settings promptly on the first session so firmware
                // version/extension (and battery) arrive without waiting for
                // the input-quiet battery poll. The settings response doubles as
                // the firmware-compatibility check surfaced during onboarding.
                if (!firmwareInfoQueried) {
                    firmwareInfoQueried = true
                    lastBatteryRefreshAtMs = SystemClock.elapsedRealtime()
                    pendingMessages.addLast(createBatteryQueryMessageLocked())
                    logLine("queue settings query for firmware info")
                }
            }
            tryConnectRing("initial")
        } catch (t: Throwable) {
            logLine("connect failed: " + safeMessage(t))
            val unpairedArm = firstUnpairedArm()
            if (unpairedArm != null) {
                handleUnpairedFailure(unpairedArm)
            } else {
                handleTransportFailure("connect failed")
            }
        }
    }

    @Throws(InterruptedException::class)
    private fun sleepDuringConnectSettling(delayMs: Long): Boolean {
        val deadline = SystemClock.elapsedRealtime() + delayMs
        synchronized(lock) {
            while (running && !userDisconnectRequested) {
                val remaining = deadline - SystemClock.elapsedRealtime()
                if (remaining <= 0) {
                    return true
                }
                lock.wait(Math.min(remaining, 100L))
            }
            return false
        }
    }

    private fun connectArm(address: String, enableRenderNotify: Boolean) {
        if (!bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw IllegalStateException("connect failed: $address")
        }
        // requestConnectionPriority has no callback in this Android compile target, so there is
        // no reliable completion point to keep it in the global GATT operation pipeline. But it's
        // important enough for performance that we call it anyways.
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH)

        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS)

        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw IllegalStateException("discoverServices failed: $address")
        }
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw IllegalStateException("enableNotifications failed: " + address + " " + BleProtocol.NOTIFY_CHAR_UUID)
        }
        if (enableRenderNotify) {
            bleManager.enableNotifications(address, BleProtocol.RENDER_NOTIFY_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)
        }
        synchronized(lock) {
            if (address.equals(rightAddress, ignoreCase = true)) {
                rightConnected = true
            } else if (address.equals(leftAddress, ignoreCase = true)) {
                leftConnected = true
            }
        }
    }

    private fun shouldAttemptRingConnect(): Boolean {
        if (!hasRingAddress()) {
            return false
        }
        val now = SystemClock.elapsedRealtime()
        synchronized(lock) {
            return running
                && sessionReady
                && !ringNotificationsReady
                && now >= ringReconnectAfterMs
                && pendingMessages.isEmpty()
                && inFlightMessages.isEmpty()
        }
    }

    private fun tryConnectRing(reason: String) {
        if (!hasRingAddress()) {
            return
        }
        try {
            connectRing()
        } catch (t: Throwable) {
            synchronized(lock) {
                ringConnected = false
                ringNotificationsReady = false
                ringReconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RING_RECONNECT_DELAY_MS
            }
            logLine("direct ring connect failed (" + reason + "): " + safeMessage(t))
        }
    }

    private fun connectRing() {
        logLine("connecting direct ring $ringAddress")
        if (!bleManager.connect(ringAddress, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw IllegalStateException("connect failed: $ringAddress")
        }

        bleManager.requestConnectionPriority(ringAddress, BluetoothGatt.CONNECTION_PRIORITY_HIGH)
        bleManager.requestMtu(ringAddress, ConnectionOptions.RING_DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS)

        if (!bleManager.discoverServices(ringAddress, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw IllegalStateException("discoverServices failed: $ringAddress")
        }

        val phoneNotify = enableRingNotification(BleProtocol.R1_PHONE_NOTIFY_CHAR_UUID)
        val dataNotify = enableRingNotification(BleProtocol.R1_NOTIFY_CHAR_UUID)
        if (!phoneNotify && !dataNotify) {
            throw IllegalStateException("no R1 notify characteristic subscribed")
        }

        synchronized(lock) {
            ringConnected = true
            ringNotificationsReady = true
            ringReconnectAfterMs = 0
        }
        logLine("direct ring ready phoneNotify=$phoneNotify dataNotify=$dataNotify")
    }

    private fun enableRingNotification(characteristicUuid: String): Boolean {
        try {
            return bleManager.enableNotifications(
                ringAddress,
                characteristicUuid,
                true,
                ConnectionOptions.DESCRIPTOR_TIMEOUT_MS
            )
        } catch (t: Throwable) {
            Log.d(TAG, "direct ring notify subscribe skipped: " + characteristicUuid + " " + safeMessage(t))
            return false
        }
    }

    /**
     * Complete the sid-0x80 security-auth exchange on both freshly opened arm
     * connections. Firmware 2.2.9 answers no queries until it completes over an
     * encrypted link and closes unauthenticated links after ~30 s (see
     * ../notes/ble-connections-2.2.9.md); on an unbonded phone the exchange is
     * also what triggers SMP pairing. Deliberately soft: on timeout we log and
     * continue rather than fail the connect — the custom firmware's response
     * behavior is not yet hardware-verified, and on stock firmware an
     * unanswered auth just means the prelude fails exactly as it did before.
     * A pairing prompt accepted after our window still bonds at the OS level,
     * so the next reconnect attempt authenticates promptly.
     */
    @Throws(InterruptedException::class)
    private fun authenticateArms() {
        val right = messageBuilder.securityAuth(false)
        val left = messageBuilder.securityAuth(true)
        val now = SystemClock.elapsedRealtime()
        for (message in arrayOf(right, left)) {
            message.onAck = MessageCallback {
            }
            message.onTimeout = MessageCallback {
            }
            message.sentAtMs = now
            writeMessage(message)
        }
        val deadline = SystemClock.elapsedRealtime() + ConnectionOptions.SECURITY_AUTH_SOFT_TIMEOUT_MS
        while (running && !userDisconnectRequested && !inFlightMessages.isEmpty()) {
            synchronized(lock) {
                if (!running || userDisconnectRequested || inFlightMessages.isEmpty()) {
                    break
                }
            }
            val remaining = deadline - SystemClock.elapsedRealtime()
            if (remaining <= 0) {
                break
            }
            interruptibleSleep.sleep(Math.min(remaining, 100L))
        }
        synchronized(lock) {
            if (!inFlightMessages.isEmpty()) {
                clearInFlightMessagesLocked("security auth timeout")
                logLine("security auth not acknowledged; continuing (2.2.9 stock requires it; older/custom firmware may not answer)")
                return
            }
        }
        val rightOk = BleProtocol.isAuthenticationSuccess(right.ackPayload, right.magic)
        val leftOk = BleProtocol.isAuthenticationSuccess(left.ackPayload, left.magic)
        logLine("security auth R=" + (if (rightOk) "ok" else "unconfirmed") + " L=" + (if (leftOk) "ok" else "unconfirmed"))
    }

    @Throws(InterruptedException::class)
    private fun sendPrelude() {
        sendPrelude(false)
    }

    @Throws(InterruptedException::class)
    private fun sendPrelude(preserveWakeLeaseControls: Boolean) {
        synchronized(lock) {
            if (preserveWakeLeaseControls) {
                clearAllMessagesPreservingWakeLeaseLocked("prelude")
            } else {
                clearAllMessagesLocked("prelude")
            }
        }
        val now = SystemClock.elapsedRealtime()
        val prelude = messageBuilder.prelude()
        prelude.onAck = MessageCallback {
        }
        prelude.onTimeout = MessageCallback {
            handleTransportFailure("ack timeout")
        }
        prelude.sentAtMs = now
        writeMessage(prelude)

        val deadline = SystemClock.elapsedRealtime() + ConnectionOptions.PRELUDE_TIMEOUT_MS
        while (running && !userDisconnectRequested && !inFlightMessages.isEmpty()) {
            synchronized(lock) {
                if (!running || userDisconnectRequested || inFlightMessages.isEmpty()) {
                    break
                }
            }
            val remaining = deadline - SystemClock.elapsedRealtime()
            if (remaining <= 0) {
                break
            }
            interruptibleSleep.sleep(Math.min(remaining, 100L))
        }
        synchronized(lock) {
            if (!inFlightMessages.isEmpty()) {
                clearInFlightMessagesLocked("prelude timeout")
                throw IllegalStateException("prelude ack timeout")
            }
        }
    }

    private fun driveSession(): Long {
        //Log.d(TAG, "driveSession called (pendingMessages.size=" + pendingMessages.size() + " inFlightMessages.size=" + inFlightMessages.size() + ")");
        while (true) {
            // Run on the sender thread, outside `lock`: Bluetooth API calls can
            // wait on the global GATT lock, and callbacks need the session lock.
            // Keep negotiation outside the timed stream. A fixed settling period
            // is only an experiment boundary; HCI must confirm actual parameters.
            var linkMode = -1
            var benchmarkAddresses: Array<String>? = null
            synchronized(lock) {
                if (benchmarkActive && benchmarkLinkPending) {
                    benchmarkLinkPending = false
                    linkMode = benchmarkLinkMode
                    benchmarkAddresses = arrayOf(leftAddress, rightAddress)
                }
            }
            val addressesToPrepare = benchmarkAddresses
            if (addressesToPrepare != null) {
                for (address in addressesToPrepare) {
                    try {
                        bleManager.prepareBenchmarkLink(address, linkMode)
                    } catch (error: RuntimeException) {
                        logLine("benchmark link request failed: " + safeMessage(error))
                    }
                }
                synchronized(lock) {
                    // Cancellation/new-run races leave the new run pending; its
                    // own preparation will replace this deadline before sending.
                    benchmarkReadyAtMs = SystemClock.elapsedRealtime() + 1_000
                }
            }
            var messageToWrite: OutboundMessage? = null
            var messageToPrewrite: OutboundMessage? = null
            val now = SystemClock.elapsedRealtime()

            maybeFinishNoChangeDesiredFrame()

            synchronized(lock) {
                drainCfwAcknowledgementsLocked()
                if (cfwCleanupDelivered) {
                    /* Successful mode 11 must be the last Faceclaw write. Drop
                     * anything a late external producer attempted to enqueue
                     * while DashboardController was closing the transport. */
                    clearPendingMessagesLocked("after CFW cleanup")
                    return 250
                }
                if (sessionReady
                        && now - lastFaceclawFramebufferLeaseQueuedAtMs >= FACECLAW_WAKE_LEASE_RENEW_MS
                        && !hasPendingOrInflightKindLocked("framebuffer-lease-control")) {
                    enqueueFaceclawFramebufferControlLocked(
                        BleProtocol.FACECLAW_FB_OP_ACQUIRE,
                        false
                    )
                }
                if (faceclawWakeLeaseEnabled
                        && sessionReady
                        && now - lastFaceclawWakeLeaseQueuedAtMs >= FACECLAW_WAKE_LEASE_RENEW_MS
                        && !hasPendingOrInflightKindLocked("wake-lease-control")) {
                    enqueueFaceclawWakeControlLocked(
                        BleProtocol.FACECLAW_WAKE_OP_ACQUIRE,
                        0,
                        false
                    )
                }
                if (!inFlightMessages.isEmpty()) {
                    val oldest = inFlightMessages.peekFirst()
                    val replay = CfwMessageWindow.replayWindow(inFlightMessages, now)
                    if (!replay.isEmpty()) {
                        logLine("CFW recovery: replay " + replay.size
                                + " unresolved message(s) from id=" + replay[0].magic)
                        for (candidate in replay) {
                            if (candidate.cfwRetries >= CfwMessageWindow.MAX_RETRIES) {
                                handleTransportFailure("CFW recovery retry limit")
                                return 0
                            }
                            logLine("CFW replay id=" + candidate.magic + " label=" + candidate.label
                                    + " cause=" + (if (candidate.cfwRetryPending) "NACK"
                                        else if (candidate.cfwAckLenses == CfwTransport.BOTH) "ordered tail" else "missing ACK")
                                    + " ackedLenses=" + candidate.cfwAckLenses
                                    + " ageMs=" + (now - candidate.sentAtMs))
                            inFlightMessages.remove(candidate)
                            magicPool.release(candidate.sid, candidate.magic, candidate.label, "CFW replay")
                            candidate.prepareCfwReplay(magicPool.allocate())
                        }
                        for (i in replay.indices.reversed()) pendingMessages.addFirst(replay[i])
                        return 0
                    }
                    if (oldest != null && oldest.ackDeadlineAtMs <= now) {
                        Log.i(TAG, "message timed out: " + oldest.label)
                        inFlightMessages.removeFirst()
                        logLine("message timed out: " + oldest.label + " sid=" + oldest.sid
                                + " id=" + oldest.magic + " ackedLenses=" + oldest.cfwAckLenses
                                + " ageMs=" + (now - oldest.sentAtMs))
                        magicPool.release(oldest.sid, oldest.magic, oldest.label, "timeout")
                        if (oldest.sid == CfwTransport.SID)
                            cfwTransports[if (oldest.isLeftArmMessage) 0 else 1].reset()
                        handleAckTimeoutLocked(oldest)
                        return 0
                    }
                    if (connectionOptions.WINDOW_SIZE <= 1
                            && sessionReady
                            && prewrittenMessage == null
                            && !pendingMessages.isEmpty()
                            && canPrewriteCandidate(pendingMessages.peekFirst())
                            && !shouldBlockPrewriteForHeartbeatLocked(now)) {
                        // Only the serial (window==1) path pre-sends the all-but-last
                        // packet; with a real window we just send the next message fully.
                        messageToPrewrite = pendingMessages.peekFirst()
                    }
                }

                if (chargingMode) {
                    // Glasses are in the case: no display traffic, only battery
                    // polls (which also detect the end of charging).
                    finishDesiredFrameLocked("discarded: glasses charging")
                    if (sessionReady && inFlightMessages.isEmpty() && !pendingMessages.isEmpty()) {
                        messageToWrite = pendingMessages.removeFirst()
                        Log.i(TAG, "sending pending message (charging): " + messageToWrite!!.label)
                    } else if (sessionReady && pendingMessages.isEmpty() && inFlightMessages.isEmpty()
                            && now - lastBatteryRefreshAtMs >= ConnectionOptions.CHARGING_BATTERY_POLL_MS) {
                        Log.i(TAG, "Writing charging-mode battery poll")
                        messageToWrite = createBatteryQueryMessageLocked()
                        lastBatteryRefreshAtMs = now
                    } else {
                        return 1_000
                    }
                } else {
                    if (messageToPrewrite == null
                            && !shutdownRequested
                            && !fixedLayoutCreated
                            && pendingMessages.isEmpty()
                            && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing create layout")
                        enqueueCreateLayoutLocked()
                    } else if (messageToPrewrite != null) {
                        // Prewrite outside the lock; the logical message remains pending until
                        // its final BLE frame is sent after the current protocol ACK.
                    }
                    if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated
                            && (if (firmwareDebugFlagsEnabled) 2 else 1) != firmwareDebugFlagsLastSent
                            && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing firmware debug flags " + (if (firmwareDebugFlagsEnabled) "show" else "hide"))
                        enqueueFirmwareDebugFlagsLocked()
                    }

                    if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated
                            && (if (compassOwners.isEmpty()) 0 else 1) != compassControlLastSent
                            && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                        val wanted = compassOwners.isNotEmpty()
                        Log.i(TAG, "enqueueing compass " + (if (wanted) "enable" else "disable"))
                        enqueueCompassControlLocked(false, wanted)
                    }

                    if (benchmarkActive) {
                        maintainBenchmarkLocked(now)
                    }

                    // Up to WINDOW_SIZE messages may be in flight at once (full
                    // pipelining); a slot frees when an ack arrives. An active
                    // bandwidth benchmark measures its own selected window instead.
                    val windowHasRoom = inFlightMessages.size <
                            Math.max(1, if (benchmarkActive) benchmarkWindowSize else connectionOptions.WINDOW_SIZE)
                    // A frame ready to send right now: don't inject a fresh
                    // heartbeat in front of it (the image's own ack resets the
                    // firmware heartbeat timer, so the heartbeat is redundant).
                    // "Ready" covers both a fresh composite still to be planned
                    // and a planned image already queued but not yet written --
                    // enqueueing sets lastEnqueuedFingerprint, so testing only
                    // the desired fingerprint left the queued-but-unwritten
                    // window unprotected and a heartbeat that came due there
                    // cost the frame a full ack round trip (measured 124ms on
                    // frame#232 of the 2026-08-20 02:27 capture).
                    // A benchmark run counts as image traffic here for the same
                    // reason: its acks reset the firmware heartbeat timer, so a
                    // fresh heartbeat in front of it is redundant.
                    val imageWaiting = !shutdownRequested && fixedLayoutCreated
                            && !hasPendingOrInflightKindLocked("heartbeat")
                            && (benchmarkActive
                                || (now >= imageRetryAfterMs
                                    && (hasPendingImageLocked()
                                        || getDesiredFingerprint() != lastEnqueuedFingerprint)))
                    noteImageStallLocked(now, windowHasRoom)
                    if (messageToPrewrite == null && handleHeartbeat(imageWaiting)) {
                        return ConnectionOptions.IDLE_SLEEP_MS.toLong()
                    }

                    if (messageToPrewrite == null && sessionReady && windowHasRoom && !pendingMessages.isEmpty()
                            && CfwMessageWindow.canSend(inFlightMessages, pendingMessages.peekFirst()!!)) {
                        messageToWrite = pendingMessages.removeFirst()
                        Log.i(TAG, "sending pending message: " + messageToWrite!!.label)
                    } else if (messageToPrewrite == null && !shutdownRequested && !benchmarkActive
                            && fixedLayoutCreated
                            && windowHasRoom && !hasPendingImageLocked()
                            && now >= imageRetryAfterMs
                            && getDesiredFingerprint() != lastEnqueuedFingerprint) {
                        // Enqueue the next frame's delta against lastEnqueuedPacked
                        // (what the shadow will be), so it can pipeline behind an
                        // image still awaiting its ack.
                        Log.i(TAG, "Enqueued image update")
                        enqueueDesiredImageLocked()
                        return 0
                    } else if (messageToPrewrite == null && shouldPollBatteryLocked(now)) {
                        Log.i(TAG, "Writing battery query")
                        messageToWrite = createBatteryQueryMessageLocked()
                        lastBatteryRefreshAtMs = now
                    } else if (messageToPrewrite == null && (!pendingMessages.isEmpty() || !inFlightMessages.isEmpty())) {
                        return ConnectionOptions.IDLE_SLEEP_MS.toLong()
                    } else if (messageToPrewrite == null) {
                        return 250
                    }
                }
            }

            val prewrite = messageToPrewrite
            if (prewrite != null) {
                if (prewriteMessage(prewrite)) {
                    return 0
                }
                return ConnectionOptions.IDLE_SLEEP_MS.toLong()
            }

            val write = messageToWrite!!
            if (!writeMessage(write)) {
                synchronized(lock) {
                    if (removePreparedMessageLocked(write) || write.magic == 0) {
                        handleTransportFailure("write failed")
                    }
                }
                return 0
            }
        }
    }

    /**
     * If the desired image already matches what the glasses display, nothing will
     * ever be enqueued for it, so finish its frame now (otherwise the TS side
     * would block on it until its backpressure timeout).
     */
    private fun maybeFinishNoChangeDesiredFrame() {
        var frameIdToFinish = 0
        synchronized(lock) {
            synchronized(desiredTilesLock) {
                if (desiredFrameId != 0 && lastEnqueuedFingerprint.isNotEmpty() && desiredFingerprint == lastEnqueuedFingerprint) {
                    frameIdToFinish = desiredFrameId
                    desiredFrameId = 0
                }
            }
        }
        if (frameIdToFinish != 0) {
            finishFrame(frameIdToFinish, "discarded: no change from displayed image")
        }
    }

    private fun shouldBlockPrewriteForHeartbeatLocked(now: Long): Boolean {
        if (shutdownRequested || !fixedLayoutCreated) {
            return false
        }
        return hasPendingOrInflightKindLocked("heartbeat")
                || now - lastHeartbeatAckedAtMs >= ConnectionOptions.HEARTBEAT_READY_MS
    }

    private fun canPrewriteCandidate(message: OutboundMessage?): Boolean {
        if (message == null || message.sid == CfwTransport.SID || !message.isLeftArmMessage) {
            return false
        }
        if ("image" != message.kind) {
            return false
        }
        return message.message.size + 2 > 232
    }

    private fun handleHeartbeat(imageWaiting: Boolean): Boolean {
        val now = SystemClock.elapsedRealtime()
        val heartbeatEligible = !shutdownRequested && fixedLayoutCreated
        val heartbeatPending = heartbeatEligible && hasPendingOrInflightKindLocked("heartbeat")
        val heartbeatElapsedMs = now - lastHeartbeatAckedAtMs
        val heartbeatReady = heartbeatEligible && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_READY_MS
        val heartbeatUrgent = heartbeatEligible && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_URGENT_MS
        val heartbeatBlocksLeftWrites = heartbeatReady || heartbeatPending

        if (heartbeatReady && !heartbeatPending && inFlightMessages.isEmpty()) {
            if (imageWaiting && !heartbeatUrgent) {
                // Defer to the waiting frame: sending it now satisfies the
                // firmware heartbeat deadline (its ack resets the timer), and
                // the heartbeat still fires once we reach the URGENT threshold
                // if rendering goes quiet again. Preserves the pending-heartbeat
                // inter-lens-sync invariant below (that path is untouched).
                return false
            }
            Log.i(TAG, "Writing heartbeat")
            val heartbeatMessage = createHeartbeatMessage()
            lastHeartbeatSentAtMs = now
            writeMessage(heartbeatMessage)
            return true
        } else if (heartbeatUrgent) {
            return true
        } else if (heartbeatPending) {
            // Don't send other message types while a heartbeat is pending because that
            // can lead to inter-lens sync issues
            return true
        }

        return false
    }

    private fun createHeartbeatMessage(): OutboundMessage {
        val message = messageBuilder.heartbeat()
        message.onAck = MessageCallback {
            synchronized(lock) {
                lastHeartbeatAckedAtMs = SystemClock.elapsedRealtime()
            }
        }
        message.onTimeout = MessageCallback {
            // If a heartbeat fails to ack and we're over the heartbeat deadline, assume the connection is failed and reconnect.
            // Otherwise ignore it, which will cause a retransmission attempt.
            val isPastDeadline: Boolean
            synchronized(lock) {
                isPastDeadline = SystemClock.elapsedRealtime() - lastHeartbeatSentAtMs >= ConnectionOptions.HEARTBEAT_FAILURE_DEADLINE_MS
            }
            if (isPastDeadline) {
                handleTransportFailure("heartbeat ack timeout")
            }
        }
        return message
    }


    private fun writeMessage(message: OutboundMessage): Boolean {
        val now = SystemClock.elapsedRealtime()
        message.writeStartedAtMs = now
        message.sentAtMs = now
        message.ackDeadlineAtMs = now + message.ackTimeoutMs + ConnectionOptions.WRITE_TIMEOUT_MS
        if (message.magic != 0) {
            synchronized(lock) {
                inFlightMessages.addLast(message)
            }
        }
        if (message.imageUpdateId > 0 && message.imageMessageNumber == 1) {
            synchronized(lock) {
                val stats = imageUpdateStats[message.imageUpdateId]
                if (stats != null && stats.firstWriteStartedAtMs <= 0) {
                    stats.firstWriteStartedAtMs = now
                }
            }
        }

        val writeAddress = if (message.isLeftArmMessage) leftAddress else rightAddress
        val frames: List<ByteArray>
        if (prewrittenMessage != null && prewrittenMessage !== message) {
            if (!spoilPrewrittenMessage("before " + message.label)) {
                return false
            }
        }
        if (prewrittenMessage === message) {
            frames = Collections.singletonList(prewrittenFrames[prewrittenFrames.size - 1])
            prewrittenMessage = null
            prewrittenFrames = Collections.emptyList()
        } else if (message.sid == CfwTransport.SID) {
            if (message.cfwRetries > 0) cfwTransports[if (message.isLeftArmMessage) 0 else 1].reset()
            frames = cfwTransports[if (message.isLeftArmMessage) 0 else 1].encode(
                    message.message, message.magic, CfwTransport.BOTH,
                    bleManager.getNegotiatedMtu(writeAddress))
        } else {
            frames = BleProtocol.framePb(
                message.message,
                message.sid,
                message.flag,
                nextTransportSeq++
            )
        }
        val result = bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            frames,
            AndroidProtocolPlatform.writeType(ConnectionOptions.WRITE_MODE),
            ConnectionOptions.WRITE_TIMEOUT_MS
        )

        synchronized(lock) {
            val sentAtMs = SystemClock.elapsedRealtime()
            message.sentAtMs = sentAtMs
            message.ackDeadlineAtMs = sentAtMs + message.ackTimeoutMs
            logImageUpdateSendLandmarkLocked(message)
            val onSent = message.onSent
            if (result && onSent != null) {
                onSent.run()
                lock.notifyAll()
            }
        }

        if (!result && message.sid == CfwTransport.SID)
            cfwTransports[if (message.isLeftArmMessage) 0 else 1].reset()
        return result
    }

    private fun prewriteMessage(message: OutboundMessage): Boolean {
        if (prewrittenMessage === message) {
            return true
        }
        if (prewrittenMessage != null && !spoilPrewrittenMessage("before prewrite " + message.label)) {
            return false
        }
        if (!canPrewriteCandidate(message)) {
            return false
        }

        val frames: List<ByteArray> = BleProtocol.framePb(
            message.message,
            message.sid,
            message.flag,
            nextTransportSeq++
        )
        if (frames.size <= 1) {
            return false
        }

        val writeAddress = if (message.isLeftArmMessage) leftAddress else rightAddress
        val prefixFrames = frames.subList(0, frames.size - 1)
        val result = bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            prefixFrames,
            AndroidProtocolPlatform.writeType(ConnectionOptions.WRITE_MODE),
            ConnectionOptions.WRITE_TIMEOUT_MS
        )
        if (!result) {
            return false
        }

        prewrittenMessage = message
        prewrittenFrames = ArrayList(frames)
        logLine("prewrote " + message.label + " frames=" + prefixFrames.size + "/" + frames.size)
        return true
    }

    private fun spoilPrewrittenMessage(reason: String): Boolean {
        val message = prewrittenMessage
        if (message == null || prewrittenFrames.isEmpty()) {
            prewrittenMessage = null
            prewrittenFrames = Collections.emptyList()
            return true
        }
        val finalFrame = Arrays.copyOf(
            prewrittenFrames[prewrittenFrames.size - 1],
            prewrittenFrames[prewrittenFrames.size - 1].size
        )
        if (finalFrame.size > 8) {
            finalFrame[finalFrame.size - 1] = (finalFrame[finalFrame.size - 1].toInt() xor 0xff).toByte()
        }
        prewrittenMessage = null
        prewrittenFrames = Collections.emptyList()

        val writeAddress = if (message.isLeftArmMessage) leftAddress else rightAddress
        logLine("spoiling prewritten " + message.label + ": " + reason)
        return bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            Collections.singletonList(finalFrame),
            AndroidProtocolPlatform.writeType(ConnectionOptions.WRITE_MODE),
            ConnectionOptions.WRITE_TIMEOUT_MS
        )
    }

    private fun removePreparedMessageLocked(message: OutboundMessage?): Boolean {
        if (message == null || message.magic == 0) {
            return false
        }
        val iterator = inFlightMessages.iterator()
        while (iterator.hasNext()) {
            if (iterator.next() === message) {
                iterator.remove()
                magicPool.release(message.sid, message.magic, message.label, "write failed")
                return true
            }
        }
        return false
    }


    /** Also drain on the worker: a clear/timeout may have removed a blocking
     * head since the last notification. Fully ACKed controls must never reach
     * the generic timeout path just because no further BLE reply arrived. */
    private fun drainCfwAcknowledgementsLocked() {
        while (true) {
            val first = CfwMessageWindow.acknowledgedHead(inFlightMessages) ?: return
            lastAckAtMs = SystemClock.elapsedRealtime()
            resolveAckLocked(first, first.ackPayload)
        }
    }

    private fun resolveAckLocked(sid: Int, magic: Int, pb: ByteArray?) {
        val iterator = inFlightMessages.iterator()
        while (iterator.hasNext()) {
            val message = iterator.next()
            if (message.sid == sid && message.magic == magic) {
                resolveAckLocked(message, pb)
                return
            }
        }
        recordUnexpectedAckLocked(sid, magic)
    }

    private fun resolveAckLocked(message: OutboundMessage, pb: ByteArray?) {
        Log.i(TAG, "Got ACK for " + message.label + "(sid=" + message.sid + ", id=" + message.magic + ")")
        inFlightMessages.remove(message)
        message.ackPayload = if (pb == null) ByteArray(0) else Arrays.copyOf(pb, pb.size)
        magicPool.release(message.sid, message.magic, message.label, "ack")
        val onAck = message.onAck
        if (onAck != null) {
            onAck.run()
        }
        consecutiveAckTimeouts = 0
        // onAck may have just satisfied a waiter blocked on lock.wait() (e.g.
        // awaitEvenHubSessionReady polling fixedLayoutCreated/displayedFingerprint
        // after a create-layout or image ack). Without this, that waiter only
        // notices on its own up-to-100ms poll tick, adding avoidable latency to
        // every EvenHub wake. Always called with lock held (see call site).
        lock.notifyAll()
    }

    private fun logImageUpdateSendLandmarkLocked(message: OutboundMessage) {
        if (message.imageUpdateId <= 0) {
            return
        }
        val stats = imageUpdateStats[message.imageUpdateId]
        val frameId = if (stats == null) 0 else stats.frameId
        if (message.imageMessageNumber == 1) {
            if (stats != null && stats.firstWriteStartedAtMs <= 0) {
                stats.firstWriteStartedAtMs = if (message.writeStartedAtMs > 0) message.writeStartedAtMs else message.sentAtMs
            }
            FrameTimings.getInstance().log(frameId, "first bluetooth packet sent")
            logImageUpdateLandmarkLocked("first bluetooth message sent", message, message.sentAtMs)
        }
        if (message.imageMessageNumber == message.imageMessageCount) {
            FrameTimings.getInstance().log(frameId,
                "last bluetooth packet sent (message " + message.imageMessageNumber + "/" + message.imageMessageCount + ")")
            logImageUpdateLandmarkLocked("last bluetooth message sent", message, message.sentAtMs)
        }
    }

    private fun logImageUpdateAckLandmarkLocked(message: OutboundMessage) {
        if (message.imageUpdateId <= 0 || message.imageMessageNumber != message.imageMessageCount) {
            return
        }
        val ackedAtMs = SystemClock.elapsedRealtime()
        FaceclawBleManager.recordDisplayFrameSent()
        val stats = imageUpdateStats.remove(message.imageUpdateId)
        if (stats != null && stats.firstWriteStartedAtMs > 0) {
            emitFrameMetrics(stats.paintMs, Math.max(0L, ackedAtMs - stats.firstWriteStartedAtMs).toInt(), stats.tileCount)
        }
        if (stats != null) {
            finishFrame(stats.frameId, "sent")
        }
        logImageUpdateLandmarkLocked("last bluetooth message acked", message, ackedAtMs)
    }

    /** Remove the stats entry for an image update that will not complete, finishing its frame. */
    private fun discardImageUpdateStatsLocked(imageUpdateId: Int, reason: String) {
        if (imageUpdateId <= 0) {
            return
        }
        val stats = imageUpdateStats.remove(imageUpdateId)
        if (stats != null) {
            finishFrame(stats.frameId, "discarded: $reason")
        }
    }

    private fun logImageUpdateLandmarkLocked(event: String, message: OutboundMessage, elapsedMs: Long) {
        logLine("image update#" + message.imageUpdateId + " " + event
                + " at " + timestamp(elapsedMs)
                + " message=" + message.imageMessageNumber + "/" + message.imageMessageCount
                + " label=" + message.label)
    }

    private fun enqueueCreateLayoutLocked() {
        // New session: re-assert the firmware-debug-flags overlay once
        // the layout is ready (the mode-7 send is gated on this having reset).
        firmwareDebugFlagsLastSent = -1
        val message = messageBuilder.createLayout()
        message.onAck = MessageCallback {
            startupProbePending = false
            clearMessagesOfKindLocked("startup-text-probe")
            fixedLayoutCreated = true
            displayedFingerprint = ""
        }
        message.onTimeout = MessageCallback {
            if (startupProbePending) {
                logLine("create layout timed out while startup text probe is pending")
                if (hasPendingOrInflightKindLocked("startup-text-probe")) {
                    return@MessageCallback
                }
                startupProbePending = false
            }
            handleTransportFailure("ack timeout")
        }
        pendingMessages.addLast(message)
        logLine("queue create layout")
    }

    private fun enqueueStartupProbeLocked() {
        enqueueCreateLayoutLocked()

        val message = messageBuilder.startupTextProbe()
        message.onAck = MessageCallback {
            startupProbePending = false
            clearMessagesOfKindLocked("create-layout")
            fixedLayoutCreated = true
            displayedFingerprint = ""
            logLine("existing dashboard layout accepted text probe")
        }
        message.onTimeout = MessageCallback {
            startupProbePending = false
            if (hasPendingOrInflightKindLocked("create-layout")) {
                return@MessageCallback
            }
            handleTransportFailure("ack timeout")
        }
        pendingMessages.addLast(message)
        startupProbePending = true
        logLine("queue startup text probe")
    }

    /**
     * Send the CFW mode-7 diagnostic-flag control op through the private stream:
     * [7][2] to show the on-glasses debug-flag overlay, [7][1] to hide it. Uses the
     * arbitrary-payload custom path (no bmp/dedup/frame-timing interaction).
     */
    private fun enqueueFirmwareDebugFlagsLocked() {
        val show = firmwareDebugFlagsEnabled
        val sub = if (show) 2 else 1
        val payload = byteArrayOf(CFW_MSG_DIAGNOSTICS.toByte(), sub.toByte())
        val message = messageBuilder.imagePayload(
            DASHBOARD_TILE, nextMapSessionId(), payload,
            "fw-debug-flags " + (if (show) "show" else "hide"),
            connectionOptions.sendImagesToLeft)
        pendingMessages.addLast(message)
        firmwareDebugFlagsLastSent = sub
        logLine("queue firmware debug flags " + (if (show) "show" else "hide"))
    }

    /**
     * Send CFW image-handler mode 10. Enable uses the configurable form
     * [10][2][interval-ms LE16][minimum-change-degrees LE16]; disable remains [10][0].
     */
    private fun enqueueCompassControlLocked(priority: Boolean, enable: Boolean) {
        val sentState = if (enable) 1 else 0
        val payload = if (enable)
            byteArrayOf(
                CFW_MSG_COMPASS.toByte(),
                2.toByte(),
                (COMPASS_REPORT_INTERVAL_MS and 0xff).toByte(),
                ((COMPASS_REPORT_INTERVAL_MS shr 8) and 0xff).toByte(),
                (COMPASS_MIN_CHANGE_DEGREES and 0xff).toByte(),
                ((COMPASS_MIN_CHANGE_DEGREES shr 8) and 0xff).toByte(),
            )
        else
            byteArrayOf(CFW_MSG_COMPASS.toByte(), 0.toByte())
        val message = messageBuilder.imagePayload(
            "compass-control",
            DASHBOARD_TILE,
            nextMapSessionId(),
            payload,
            "compass " + (if (enable) "enable" else "disable"),
            connectionOptions.sendImagesToLeft)
        message.onTimeout = MessageCallback {
            compassControlLastSent = -1
            logLine("compass control ack timeout")
        }
        if (enable) {
            compassMaybeOn = true
        } else {
            message.onAck = MessageCallback { compassMaybeOn = false }
        }
        if (priority) pendingMessages.addFirst(message)
        else pendingMessages.addLast(message)
        compassControlLastSent = sentState
        logLine("queue " + message.label)
    }

    private fun enqueueDesiredImageLocked() {
        val fingerprint = getDesiredFingerprint()
        val packedSnapshot: ByteArray?
        val width: Int
        val height: Int
        val paintMs: Int
        val frameId: Int
        val draws: Array<SurfaceCompositor.ScreenDraw>?
        val scene: ShellScene
        synchronized(desiredTilesLock) {
            packedSnapshot = desiredPacked
            width = desiredWidth
            height = desiredHeight
            paintMs = desiredPaintMs
            frameId = desiredFrameId
            draws = desiredDraws
            scene = desiredShellScene
            desiredFrameId = 0
        }
        val packedFrame: ByteArray = packedSnapshot ?: ByteArray(0)
        if (customFirmwareDetected && packedFrame.size > 0) {
            val rendered = scenePlanner.plan(packedFrame, width, height, draws, scene, nextImageFrameId,
                connectionOptions.TEXTURE_CACHE_FRAMES, connectionOptions.INCREMENTAL_FRAMES,
                connectionOptions.MULTI_RECT_FRAMES, ConnectionOptions.MULTI_RECT_MAX_RECTS)
            nextImageFrameId = rendered.nextFid
            val commands = rendered.commands
            for (i in 0 until commands.size - 1) enqueueResourceCommandLocked(commands[i])
            val plan = BleImageOptimizer.TileImagePlan(
                0, DASHBOARD_TILE, packedFrame, width, height, nextMapSessionId(), commands[commands.size - 1])
            finishEnqueueDesiredImageLocked(plan, fingerprint, paintMs, frameId)
            return
        }

        FrameTimings.getInstance().spanStart(frameId, "compress-and-plan")
        // Incremental (mode 3 bounding box) update against the last ENQUEUED frame
        // (the base the firmware shadow will hold when this update is applied).
        // lastEnqueuedPacked is cleared whenever the image pipeline is cleared, so
        // a non-empty value means the display base is trusted.
        var incrementalPayload: ByteArray? = null
        var incrementalLog: String? = null
        if (connectionOptions.INCREMENTAL_FRAMES && lastEnqueuedPacked.size > 0
                && lastEnqueuedWidth == width && lastEnqueuedHeight == height) {
            val baseFid = nextImageFrameId
            val single =
                BleImageOptimizer.buildIncrementalImagePayload(lastEnqueuedPacked, packedFrame, width, height, baseFid)
            if (single != null) {
                incrementalPayload = single.payload
                // advance only when a delta is actually emitted, so consecutive
                // deltas carry consecutive ids (CFW skip/reorder detection)
                nextImageFrameId = if (nextImageFrameId >= 0xfffe) 1 else nextImageFrameId + 1
                incrementalLog = "incremental update bbox=" +
                    ((single.payload[3].toInt() and 0xff) * 4) + "x" + ((single.payload[4].toInt() and 0xff) * 2) +
                    "+" + ((single.payload[1].toInt() and 0xff) * 4) + "+" + ((single.payload[2].toInt() and 0xff) * 2) +
                    " changed=" + single.changedBytes + "/" + single.boxBytes + "B" +
                    " clusters=" + single.clusterCount

                // When the bounding box spans multiple clusters or is sizeable, try
                // splitting into tight rects (CFW mode-8). Only replace the single
                // box if the multi-rect message is actually smaller on the wire.
                if (connectionOptions.MULTI_RECT_FRAMES
                        && (single.clusterCount > 1 || single.payload.size > ConnectionOptions.MULTI_RECT_MIN_PAYLOAD)) {
                    val multi = BleImageOptimizer.buildMultiRectImagePayload(
                        lastEnqueuedPacked, packedFrame, width, height, baseFid, ConnectionOptions.MULTI_RECT_MAX_RECTS)
                    if (multi != null && multi.payload.size < single.payload.size) {
                        incrementalPayload = multi.payload
                        nextImageFrameId = multi.nextFid   // rectCount fids consumed
                        incrementalLog = "multi-rect update n=" + multi.rectCount +
                            " covered=" + multi.coveredBytes + "B" +
                            " payload=" + multi.payload.size + "B (vs bbox " + single.payload.size + "B)"
                    }
                }
            }
        }
        val plan = if (incrementalPayload != null)
            BleImageOptimizer.TileImagePlan(0, DASHBOARD_TILE, packedFrame, width, height, nextMapSessionId(), incrementalPayload)
        else
            BleImageOptimizer.TileImagePlan(0, DASHBOARD_TILE, packedFrame, width, height, nextMapSessionId())
        FrameTimings.getInstance().spanEnd(frameId, "compress-and-plan")
        if (incrementalLog != null) {
            FrameTimings.getInstance().log(frameId, incrementalLog)
        }
        finishEnqueueDesiredImageLocked(plan, fingerprint, paintMs, frameId)
    }

    /** Queue complete private commands, advance the delta base, and retain frame/ACK bookkeeping. */
    private fun finishEnqueueDesiredImageLocked(
            plan: BleImageOptimizer.TileImagePlan, fingerprint: String, paintMs: Int, frameId: Int) {
        val updateId = nextImageUpdateId++
        val commands: MutableList<ByteArray> = ArrayList()
        if (plan.payload.size <= CfwTransport.MAX_MESSAGE) {
            commands.add(plan.payload)
        } else {
            // A noisy full frame can exceed the stream record limit. Repaint it
            // with independently decodable RLE bands below the decoded-message limit.
            commands.addAll(BleImageOptimizer.encodeFullFrameBands(
                    plan.packed!!, plan.width, plan.height, nextImageFrameId))
            for (i in 0 until commands.size) {
                nextImageFrameId = if (nextImageFrameId >= 0xfffe) 1 else nextImageFrameId + 1
            }
        }
        val messageCount = commands.size
        imageUpdateStats[updateId] = BleImageOptimizer.ImageUpdateStats(paintMs, 1, frameId)
        for (i in 0 until commands.size) {
            enqueueCustomImageLocked(plan, commands[i], fingerprint, updateId, i + 1, messageCount)
        }
        // This frame is now the base for the next delta (it will be the firmware
        // shadow once applied), even though it hasn't been acked yet — that is what
        // lets the next frame pipeline behind it. plan.packed is the full frame;
        // frames are immutable by convention, so referencing it is safe.
        lastEnqueuedPacked = plan.packed!!
        lastEnqueuedWidth = plan.width
        lastEnqueuedHeight = plan.height
        lastEnqueuedFingerprint = fingerprint

        FrameTimings.getInstance().log(frameId, "queued image update#" + updateId
                + " messages=" + messageCount + " payload=" + plan.payload.size + "B")
        logLine("queue image update#" + updateId + " fingerprint=" + fingerprint
                + " messages=" + messageCount)
    }

    /**
     * Enqueue one resource eviction/upload command ahead of the image message that
     * references its glyphs (the transport is FIFO, so no ack round trip is
     * needed before use). A timeout means the on-glasses cache state is
     * unknown; forget everything phone-side (glyphs re-upload lazily) and let
     * the accompanying image update's own timeout drive the frame resync.
     */
    private fun enqueueResourceCommandLocked(payload: ByteArray) {
        val message = messageBuilder.imagePayload(
            "resources",
            DASHBOARD_TILE,
            nextMapSessionId(),
            payload,
            "resource command " + payload.size + "B",
            connectionOptions.sendImagesToLeft)
        message.onTimeout = MessageCallback {
            resourceCache.reset()
            logLine("resource command ack timeout; resource cache state reset")
        }
        pendingMessages.addLast(message)
        logLine("queue " + message.label)
    }

    private fun enqueueCustomImageLocked(
        plan: BleImageOptimizer.TileImagePlan,
        payload: ByteArray,
        fingerprint: String,
        updateId: Int,
        messageNumber: Int,
        messageCount: Int
    ) {
        val message = messageBuilder.customMessage("image", payload,
                "image " + plan.tile.name + "#" + messageNumber, plan.tileIndex, connectionOptions.sendImagesToLeft)
        message.setImageUpdatePosition(updateId, messageNumber, messageCount)
        message.onAck = MessageCallback {
            imageRetryAfterMs = 0
            // Firmware >= 2.2.4.34 resets its heartbeat timer when it receives
            // image messages (not just heartbeats), so an acked image fragment
            // satisfies the heartbeat deadline and heartbeats stop contending
            // with active rendering.
            lastHeartbeatAckedAtMs = SystemClock.elapsedRealtime()
            logImageUpdateAckLandmarkLocked(message)
            var imageStillInFlight = false
            for (inFlight in inFlightMessages) {
                if ("image" == inFlight.kind) {
                    imageStillInFlight = true
                    break
                }
            }
            if (!imageStillInFlight) {
                var imageStillQueued = false
                for (queued in pendingMessages) {
                    if ("image" == queued.kind) {
                        imageStillQueued = true
                        break
                    }
                }
                if (!imageStillQueued) {
                    displayedFingerprint = fingerprint
                }
            }
        }
        message.onTimeout = MessageCallback {
            discardImageUpdateStatsLocked(message.imageUpdateId, "image ack timeout (will retry)")
            clearMessagesOfKindLocked("image")
            displayedFingerprint = ""
            imageRetryAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.IMAGE_RETRY_DELAY_MS
        }
        pendingMessages.addLast(message)
    }

    private fun createAudioControlMessageLocked(enable: Boolean): OutboundMessage {
        val message = messageBuilder.enableOrDisableMic(enable)
        message.onAck = MessageCallback {
            lastAudioControlAckMagic = message.magic
            audioCaptureActive = message.label?.contains("enable") == true
            logLine(if (audioCaptureActive) "G2 mic enabled" else "G2 mic disabled")
        }
        message.onTimeout = MessageCallback {
            handleTransportFailure("audio control ack timeout")
        }
        return message
    }

    private fun shouldPollBatteryLocked(now: Long): Boolean {
        return !shutdownRequested
                && sessionReady
                && pendingMessages.isEmpty()
                && inFlightMessages.isEmpty()
                && now - lastConnectionOrInputAtMs >= ConnectionOptions.BATTERY_INPUT_QUIET_MS
                && (lastBatteryRefreshAtMs == 0L || now - lastBatteryRefreshAtMs >= ConnectionOptions.BATTERY_REFRESH_INTERVAL_MS)
    }

    private fun createBatteryQueryMessageLocked(): OutboundMessage {
        val message = messageBuilder.batteryQuery()
        message.onAck = MessageCallback {
            val ring = BleProtocol.parseRingBattery(message.ackPayload)
            // Old firmware and missing/malformed extensions must clear any prior reading.
            ringBattery = if (ring == null) -1 else ring.battery
            ringCharging = if (ring == null) -1 else ring.charging
            val snapshot = BleProtocol.parseSettingsBattery(message.ackPayload)
            if (snapshot != null) {
                headsetBattery = snapshot.battery
                headsetCharging = snapshot.charging
                emitBatteryState(headsetBattery, headsetCharging)
                if (snapshot.silentMode >= 0) {
                    // Backstop for the push in onNotification: the firmware is
                    // confirmed to push silent-mode-on, but the off transition is
                    // not, so re-read the authoritative value on every poll.
                    updateSilentModeLocked(snapshot.silentMode > 0)
                }
                updateChargingModeLocked(snapshot.charging > 0, snapshot.battery)
            }
            val firmwareInfo = BleProtocol.parseSettingsFirmwareInfo(message.ackPayload)
            if (firmwareInfo != null) {
                customFirmwareDetected = firmwareInfo.isFaceclawFirmware()
                emitFirmwareInfo(firmwareInfo)
            }
        }
        message.onTimeout = MessageCallback {
            logLine("Battery query timed out")
        }
        return message
    }

    /**
     * Track silent mode, which the wearer toggles by long-pressing both
     * touchpads at once. While it is on the firmware refuses input events and
     * app launches and powers the display down, so the glasses look dead even
     * though the BLE session is healthy; the phone UI says so explicitly.
     */
    private fun updateSilentModeLocked(silent: Boolean) {
        val next = if (silent) 1 else 0
        if (silentMode == next) {
            return
        }
        silentMode = next
        logLine(if (silent) "glasses entered silent mode" else "glasses left silent mode")
        emitSilentMode(silent)
    }

    /**
     * Track whether the glasses are in the charging case. Charging means nobody
     * is wearing them: display communication pauses (no heartbeats, so the
     * firmware tears down its EvenHub context on its own) and only battery polls
     * continue. When charging stops, tear the transport down and let the normal
     * reconnect loop rebuild the session, layout, and first frame.
     */
    private fun updateChargingModeLocked(charging: Boolean, battery: Int) {
        if (charging == chargingMode) {
            if (chargingMode) {
                setStateDisplay("charging", chargingStatusText(battery))
            }
            return
        }
        if (charging) {
            chargingMode = true
            clearAllMessagesLocked("glasses charging")
            fixedLayoutCreated = false
            startupProbePending = false
            displayedFingerprint = ""
            finishDesiredFrameLocked("discarded: glasses charging")
            logLine("glasses are charging; pausing display communication")
            setStateDisplay("charging", chargingStatusText(battery))
        } else {
            chargingMode = false
            logLine("glasses removed from charger; reconnecting")
            handleTransportFailure("charging ended")
        }
    }

    /**
     * Record, into the frame that is waiting, why it did not go out on this
     * pass of the send loop. Without this the export shows a bare multi-second
     * jump between "image submitted as desired frame" and the first BLE
     * packet, with no hint whether we were blocked on a heartbeat, the
     * BLE window, or another message queued ahead. Deduped on (frame, reason),
     * so a frame stalled for seconds gets one line per state change rather
     * than one per loop pass.
     */
    private fun noteImageStallLocked(now: Long, windowHasRoom: Boolean) {
        var frameId: Int
        synchronized(desiredTilesLock) {
            frameId = desiredFrameId
        }
        val reason: String?
        if (frameId != 0 && getDesiredFingerprint() != lastEnqueuedFingerprint) {
            reason = describeEnqueueBlockerLocked(now, windowHasRoom)
        } else {
            // Nothing waiting to be planned; an already-planned image may still
            // be queued behind other traffic.
            val queuedImage = firstPendingImageLocked()
            frameId = if (queuedImage == null) 0 else imageUpdateFrameIdLocked(queuedImage.imageUpdateId)
            reason = if (queuedImage == null) null else describeWriteBlockerLocked(now, windowHasRoom, queuedImage)
        }
        if (frameId == 0 || reason == null) {
            stallFrameId = 0
            stallReason = ""
            return
        }
        if (frameId == stallFrameId && reason == stallReason) {
            return
        }
        stallFrameId = frameId
        stallReason = reason
        FrameTimings.getInstance().log(frameId, "waiting to send: $reason")
    }

    /** Why the desired composite has not been turned into wire messages yet, or null. */
    private fun describeEnqueueBlockerLocked(now: Long, windowHasRoom: Boolean): String? {
        if (shutdownRequested) {
            return "shutdown requested"
        }
        if (!sessionReady) {
            return "BLE session not ready"
        }
        if (!fixedLayoutCreated) {
            return "display layout not created yet"
        }
        if (now < imageRetryAfterMs) {
            return "image retry backoff (" + (imageRetryAfterMs - now) + "ms left)"
        }
        if (hasPendingImageLocked()) {
            return "an earlier image is still queued"
        }
        if (!windowHasRoom) {
            return "BLE window full (" + inFlightMessages.size + " message(s) in flight)"
        }
        if (hasPendingOrInflightKindLocked("heartbeat")) {
            return "heartbeat in flight"
        }
        if (!pendingMessages.isEmpty()) {
            return pendingMessages.size.toString() + " message(s) queued ahead, next " +
                pendingMessages.peekFirst().label
        }
        return null
    }

    /** Why a planned image message has not been written to BLE yet, or null. */
    private fun describeWriteBlockerLocked(now: Long, windowHasRoom: Boolean, queuedImage: OutboundMessage): String? {
        if (!sessionReady) {
            return "BLE session not ready"
        }
        if (!windowHasRoom) {
            return "BLE window full (" + inFlightMessages.size + " message(s) in flight)"
        }
        if (hasPendingOrInflightKindLocked("heartbeat")) {
            return "heartbeat in flight"
        }
        // handleHeartbeat is a barrier: while one is due it holds back every
        // other write, so a frame queued at the wrong moment waits a heartbeat
        // round trip. Reported explicitly because it is otherwise invisible --
        // heartbeats belong to no frame.
        val heartbeatElapsedMs = now - lastHeartbeatAckedAtMs
        if (fixedLayoutCreated && !shutdownRequested
                && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_READY_MS) {
            return "heartbeat due (" + heartbeatElapsedMs + "ms since the last one acked)"
        }
        val head = pendingMessages.peekFirst()
        if (head != null && head !== queuedImage) {
            return "queued behind " + head.label
        }
        return null
    }

    private fun firstPendingImageLocked(): OutboundMessage? {
        for (message in pendingMessages) {
            if (message.imageUpdateId > 0) {
                return message
            }
        }
        return null
    }

    private fun imageUpdateFrameIdLocked(imageUpdateId: Int): Int {
        val stats = imageUpdateStats[imageUpdateId]
        return if (stats == null) 0 else stats.frameId
    }

    private fun finishDesiredFrameLocked(outcome: String) {
        val frameIdToFinish: Int
        synchronized(desiredTilesLock) {
            frameIdToFinish = desiredFrameId
            desiredFrameId = 0
        }
        finishFrame(frameIdToFinish, outcome)
    }

    private fun hasPendingOrInflightKindLocked(kind: String): Boolean {
        for (queued in pendingMessages) {
            if (kind == queued.kind) {
                return true
            }
        }
        for (inFlight in inFlightMessages) {
            if (kind == inFlight.kind) {
                return true
            }
        }
        return false
    }

    private fun hasPendingOrInflightMagicLocked(magic: Int): Boolean {
        for (queued in pendingMessages) {
            if (queued.magic == magic) {
                return true
            }
        }
        for (inFlight in inFlightMessages) {
            if (inFlight.magic == magic) {
                return true
            }
        }
        return false
    }

    private fun hasPendingMagicLocked(sid: Int, magic: Int): Boolean {
        for (queued in pendingMessages) {
            if (queued.sid == sid && queued.magic == magic) {
                return true
            }
        }
        return false
    }

    private fun handleAckTimeoutLocked(message: OutboundMessage) {
        consecutiveAckTimeouts += 1

        val onTimeout = message.onTimeout
        if (onTimeout != null) {
            onTimeout.run()
        }

        if (consecutiveAckTimeouts > ConnectionOptions.MAX_CONSECUTIVE_ACK_TIMEOUTS) {
            handleTransportFailure("too many ack timeouts")
        }
    }

    /**
     * Replace any stale lease control with one right-arm and one left-arm
     * fire-and-forget write. With priority=true the right arm is sent first so
     * CLAIM reaches the lens that originated the deferred wake immediately.
     */
    private fun enqueueFaceclawWakeControlLocked(operation: Int, nonce: Int, priority: Boolean): Int {
        clearMessagesOfKindLocked("wake-lease-control")
        val generation = ++faceclawWakeControlGeneration
        faceclawWakeControlSentCount = 0
        if (operation == BleProtocol.FACECLAW_WAKE_OP_ACQUIRE) {
            lastFaceclawWakeLeaseQueuedAtMs = SystemClock.elapsedRealtime()
        }
        val onSent = MessageCallback {
            if (faceclawWakeControlGeneration == generation) {
                faceclawWakeControlSentCount += 1
            }
        }
        val right = messageBuilder.faceclawWakeControl(operation, nonce, false)
        val left = messageBuilder.faceclawWakeControl(operation, nonce, true)
        right.onSent = onSent
        left.onSent = onSent
        if (priority) {
            pendingMessages.addFirst(left)
            pendingMessages.addFirst(right)
        } else {
            pendingMessages.addLast(right)
            pendingMessages.addLast(left)
        }
        logLine("queue " + right.label + " + L")
        return generation
    }

    private fun waitForFaceclawWakeControlDelivery(generation: Int, timeoutMs: Long): Boolean {
        val deadline = SystemClock.elapsedRealtime() + Math.max(0L, timeoutMs)
        synchronized(lock) {
            while (running
                    && sessionReady
                    && faceclawWakeControlGeneration == generation
                    && faceclawWakeControlSentCount < 2) {
                val remaining = deadline - SystemClock.elapsedRealtime()
                if (remaining <= 0) {
                    break
                }
                try {
                    lock.wait(Math.min(remaining, 100L))
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }
            return faceclawWakeControlGeneration == generation
                && faceclawWakeControlSentCount >= 2
        }
    }

    /**
     * Acquire/renew or release CFW's independent direct-framebuffer repaint
     * guard on both arms. It is separate from the optional idle-wake lease:
     * every Faceclaw display session needs this guard while its EvenHub layout
     * contains swipe-capturing stock widgets.
     */
    private fun enqueueFaceclawFramebufferControlLocked(operation: Int, priority: Boolean): Int {
        clearMessagesOfKindLocked("framebuffer-lease-control")
        val generation = ++faceclawFramebufferControlGeneration
        faceclawFramebufferControlSentCount = 0
        if (operation == BleProtocol.FACECLAW_FB_OP_ACQUIRE) {
            lastFaceclawFramebufferLeaseQueuedAtMs = SystemClock.elapsedRealtime()
        }
        val onSent = MessageCallback {
            if (faceclawFramebufferControlGeneration == generation) {
                faceclawFramebufferControlSentCount += 1
            }
        }
        val right = messageBuilder.faceclawFramebufferControl(operation, false)
        val left = messageBuilder.faceclawFramebufferControl(operation, true)
        right.onSent = onSent
        left.onSent = onSent
        if (priority) {
            pendingMessages.addFirst(left)
            pendingMessages.addFirst(right)
        } else {
            pendingMessages.addLast(right)
            pendingMessages.addLast(left)
        }
        logLine("queue " + right.label + " + L")
        return generation
    }

    private fun waitForFaceclawFramebufferControlDelivery(generation: Int, timeoutMs: Long): Boolean {
        val deadline = SystemClock.elapsedRealtime() + Math.max(0L, timeoutMs)
        synchronized(lock) {
            while (running
                    && sessionReady
                    && faceclawFramebufferControlGeneration == generation
                    && faceclawFramebufferControlSentCount < 2) {
                val remaining = deadline - SystemClock.elapsedRealtime()
                if (remaining <= 0) {
                    break
                }
                try {
                    lock.wait(Math.min(remaining, 100L))
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }
            return faceclawFramebufferControlGeneration == generation
                && faceclawFramebufferControlSentCount >= 2
        }
    }

    private fun releaseFaceclawFramebufferLease(): Boolean {
        val generation: Int
        synchronized(lock) {
            if (!running || !sessionReady) {
                return true
            }
            generation = enqueueFaceclawFramebufferControlLocked(
                BleProtocol.FACECLAW_FB_OP_RELEASE,
                true
            )
        }
        interruptibleSleep.interrupt()
        return waitForFaceclawFramebufferControlDelivery(
            generation,
            FACECLAW_WAKE_CONTROL_WAIT_MS
        )
    }

    private fun clearMessagesOfKindLocked(kind: String) {
        val pendingIterator = pendingMessages.iterator()
        while (pendingIterator.hasNext()) {
            val message = pendingIterator.next()
            if (kind == message.kind) {
                pendingIterator.remove()
                discardPrewriteIfMatchesLocked(message)
                if ("image" == kind) {
                    discardImageUpdateStatsLocked(message.imageUpdateId, "pending messages cleared ($kind)")
                }
                magicPool.release(message.sid, message.magic, message.label, "cleared pending $kind")
            }
        }
        val inFlightIterator = inFlightMessages.iterator()
        while (inFlightIterator.hasNext()) {
            val message = inFlightIterator.next()
            if (kind == message.kind) {
                inFlightIterator.remove()
                if ("image" == kind) {
                    discardImageUpdateStatsLocked(message.imageUpdateId, "inflight messages cleared ($kind)")
                }
                magicPool.release(message.sid, message.magic, message.label, "cleared inflight $kind")
            }
        }
        if ("image" == kind) {
            // The image pipeline was flushed (e.g. ack timeout -> keyframe resync):
            // drop the pipelined delta base so the next image is a full keyframe.
            lastEnqueuedPacked = ByteArray(0)
            lastEnqueuedFingerprint = ""
        }
    }

    private fun clearAllMessagesLocked(reason: String) {
        clearPendingMessagesLocked(reason)
        clearInFlightMessagesLocked(reason)
        // The image pipeline is gone: drop the pipelined delta base so the next
        // image is a full keyframe rather than a delta onto a stale base.
        lastEnqueuedPacked = ByteArray(0)
        lastEnqueuedFingerprint = ""
        // Queued resource commands (if any) were dropped with the rest, and the
        // session churn behind a full clear may have freed the on-glasses
        // cache; forget it phone-side so glyphs re-upload lazily.
        resourceCache.reset()
    }

    /**
     * A custom wake queues CLAIM before NativeScript asks for a resume. Keep
     * that private control while flushing stale EvenHub traffic around the
     * direct prelude write.
     */
    private fun clearAllMessagesPreservingWakeLeaseLocked(reason: String) {
        val pendingIterator = pendingMessages.iterator()
        while (pendingIterator.hasNext()) {
            val message = pendingIterator.next()
            if ("wake-lease-control" == message.kind) {
                continue
            }
            pendingIterator.remove()
            discardPrewriteIfMatchesLocked(message)
            discardImageUpdateStatsLocked(
                message.imageUpdateId,
                "pending messages cleared: $reason"
            )
            magicPool.release(
                message.sid,
                message.magic,
                message.label,
                "cleared pending: $reason"
            )
        }
        clearInFlightMessagesLocked(reason)
        lastEnqueuedPacked = ByteArray(0)
        lastEnqueuedFingerprint = ""
        resourceCache.reset()
    }

    /** Any image update whose fragments are still queued (not yet sent). */
    private fun hasPendingImageLocked(): Boolean {
        for (message in pendingMessages) {
            if ("image" == message.kind) {
                return true
            }
        }
        return false
    }

    private fun clearPendingMessagesLocked(reason: String) {
        while (!pendingMessages.isEmpty()) {
            val message = pendingMessages.removeFirst()
            discardPrewriteIfMatchesLocked(message)
            discardImageUpdateStatsLocked(message.imageUpdateId, "pending messages cleared: $reason")
            magicPool.release(message.sid, message.magic, message.label, "cleared pending: $reason")
        }
    }

    private fun clearInFlightMessagesLocked(reason: String) {
        while (!inFlightMessages.isEmpty()) {
            val message = inFlightMessages.removeFirst()
            discardImageUpdateStatsLocked(message.imageUpdateId, "inflight messages cleared: $reason")
            magicPool.release(message.sid, message.magic, message.label, "cleared inflight: $reason")
        }
    }

    private fun discardPrewriteIfMatchesLocked(message: OutboundMessage?) {
        if (message != null && message === prewrittenMessage) {
            prewrittenMessage = null
            prewrittenFrames = Collections.emptyList()
        }
    }

    private fun recordUnexpectedAckLocked(sid: Int, magic: Int) {
        if (magic < BleMagicPool.MIN_MAGIC || magic > BleMagicPool.MAX_MAGIC) {
            return
        }
        val previous = magicPool.getReleaseRecord(sid, magic)
        if (previous == null) {
            val pendingNote = if (hasPendingMagicLocked(sid, magic)) " while that magic is only pending locally" else ""
            logLine("unexpected ACK sid=" + sid + " magic=" + magic + pendingNote
                    + "; possible Even app BLE contention")
            return
        }
        if ("timeout" == previous.reason) {
            logLine("late ACK after timeout sid=" + sid + " magic=" + magic
                    + " label=" + previous.label
                    + "; ACK timeout may be too short")
            return
        }
        if ("ack" == previous.reason) {
            logLine("duplicate ACK for already-acked message sid=" + sid + " magic=" + magic
                    + " label=" + previous.label
                    + "; possible Even app BLE contention")
            return
        }
        logLine("late ACK for released message sid=" + sid + " magic=" + magic
                + " label=" + previous.label
                + " release=" + previous.reason)
    }

    /** The address of a configured arm Android no longer holds a bond for, or null. */
    private fun firstUnpairedArm(): String? {
        if (!bleManager.isBonded(rightAddress)) return rightAddress
        if (!bleManager.isBonded(leftAddress)) return leftAddress
        return null
    }

    /**
     * A connect failure while an arm's bond is missing (the pairing was
     * forgotten in Android settings, or the address was typed in by hand and
     * never paired) will repeat forever, so instead of scheduling a retry,
     * park the worker loop and tell the user to re-pair. Only an explicit
     * connect (which builds a fresh communicator) starts a new attempt.
     */
    private fun handleUnpairedFailure(address: String) {
        Log.e(TAG, "Connect failed and $address is not paired; suspending reconnect")
        synchronized(lock) {
            reconnectHalted = true
            sessionReady = false
            fixedLayoutCreated = false
            startupProbePending = false
            shutdownRequested = false
            chargingMode = false
            imageRetryAfterMs = 0
            displayedFingerprint = ""
            faceclawWakePendingNonce = -1
            lastFaceclawWakeLeaseQueuedAtMs = 0
            faceclawWakeControlSentCount = 0
            clearAllMessagesLocked("arm not paired: $address")
            reconnectAfterMs = Long.MAX_VALUE
            bleManager.disconnect(rightAddress)
            bleManager.disconnect(leftAddress)
        }
        if (!userDisconnectRequested) {
            setStateDisplay(
                "unpaired",
                "The glasses (" + address + ") are not paired with this phone."
                    + " Use \"Pair glasses\" to pair them again, then connect."
            )
        }
        interruptibleSleep.interrupt()
    }

    private fun handleTransportFailure(reason: String?) {
        Log.e(TAG, "Transport failure: $reason")
        synchronized(lock) {
            maybeEmitEvenAppConflictLocked(reason)
            finishBenchmarkLocked(true, "transport failure")
            sessionReady = false
            fixedLayoutCreated = false
            startupProbePending = false
            shutdownRequested = false
            chargingMode = false
            imageRetryAfterMs = 0
            displayedFingerprint = ""
            faceclawWakePendingNonce = -1
            lastFaceclawWakeLeaseQueuedAtMs = 0
            faceclawWakeControlSentCount = 0
            clearAllMessagesLocked("transport failure: $reason")
            reconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RECONNECT_DELAY_MS
            bleManager.disconnect(rightAddress)
            bleManager.disconnect(leftAddress)
        }
        if (!userDisconnectRequested) {
            setStateDisplay("retrying", if (reason == null || reason.isEmpty()) "Reconnecting..." else "Reconnecting after $reason")
        }
        interruptibleSleep.interrupt()
    }

    private fun resetSessionStateLocked() {
        ringBattery = -1
        ringCharging = -1
        sessionReady = false
        shutdownRequested = false
        fixedLayoutCreated = false
        chargingMode = false
        rightConnected = false
        leftConnected = false
        ringConnected = false
        ringNotificationsReady = false
        reconnectAfterMs = 0
        reconnectHalted = false
        ringReconnectAfterMs = 0
        lastAckAtMs = 0
        lastIncomingAtMs = 0
        lastHeartbeatSentAtMs = 0
        lastSessionReadyAtMs = 0
        consecutiveAckTimeouts = 0
        lastAudioControlAckMagic = 0
        audioCaptureActive = false
        audioPacketListener = null
        compassControlLastSent = -1
        // A dead transport orphans any glasses-side compass state; the fresh
        // session re-asserts the desired state once its layout is ready.
        compassMaybeOn = false
        faceclawWakePendingNonce = -1
        lastFaceclawWakeLeaseQueuedAtMs = 0
        faceclawWakeControlSentCount = 0
        cfwCleanupDelivered = false
        for (transport in cfwTransports) transport.reset()
        lastCfwCleanupAckMagic = 0
        wearState = -1
        displayedFingerprint = ""
        // Deliberately not clearing silentMode: it is a property of the glasses,
        // not of our session, and silent mode blocks app launches, so it can be
        // the very cause of the session teardown that got us here.
    }

    private fun emitRingEvent(event: G2Event, frameId: Int) {
        val current = listener
        if (current == null) {
            FrameTimings.getInstance().finishFrame(frameId, "discarded: no listener attached")
            return
        }
        val containerNameSnapshot = event.containerName
        mainHandler.post {
            FrameTimings.getInstance().log(frameId, "dispatching input event on main thread")
            try {
                current.onRingEvent(event.kind, containerNameSnapshot, event.eventType, event.eventSource, event.systemExitReasonCode, frameId,
                        event.ringTick, event.ringType, event.ringAux, event.ringSpeed)
            } catch (t: Throwable) {
                Log.w(TAG, "listener onRingEvent failed", t)
                FrameTimings.getInstance().finishFrame(frameId, "discarded: listener onRingEvent failed")
            }
        }
    }

    /** Finish a frame owned by the communicator and tell the TS side, which may be awaiting it. */
    private fun finishFrame(frameId: Int, outcome: String) {
        if (frameId <= 0) {
            return
        }
        FrameTimings.getInstance().finishFrame(frameId, outcome)
        val current = listener ?: return
        mainHandler.post {
            try {
                current.onFrameFinished(frameId, outcome)
            } catch (t: Throwable) {
                Log.w(TAG, "listener onFrameFinished failed", t)
            }
        }
    }

    private fun emitImuData(x: Double, y: Double, z: Double, eventSource: Int) {
        if (imuListeners.isEmpty()) {
            return
        }
        mainHandler.post {
            for (imuListener in imuListeners) {
                try {
                    imuListener.onImuData(x, y, z, eventSource)
                } catch (t: Throwable) {
                    Log.w(TAG, "listener onImuData failed", t)
                }
            }
        }
    }

    private fun emitCompassEvent(event: BleProtocol.CompassEvent) {
        if (event.diagnosticFlags >= 0) {
            val sources = arrayOf("unknown", "GRV", "GMRV", "RV")
            Log.i("FaceclawCompass", "heading=" + event.headingDegrees
                + " magneticAccuracy=" + event.magneticAccuracy
                + " magneticAnomalies=" + event.magneticAnomalies
                + " orientationSource=" + sources[event.orientationSource]
                + " flags=0x" + Integer.toHexString(event.diagnosticFlags)
                + " sampleTimeMs=" + event.sampleTimeMs)
        }
        for (subscription in compassSubscriptions) {
            subscription.handler.post {
                try {
                    subscription.listener.onCompassEvent(event.command, event.headingDegrees,
                        event.magneticAccuracy, event.magneticAnomalies, event.orientationSource,
                        event.diagnosticFlags, event.sampleTimeMs)
                } catch (t: Throwable) {
                    Log.w(TAG, "listener onCompassEvent failed", t)
                }
            }
        }
    }

    private fun emitSilentMode(silent: Boolean) {
        val current = listener ?: return
        mainHandler.post {
            try {
                current.onSilentMode(silent)
            } catch (t: Throwable) {
                Log.w(TAG, "listener onSilentMode failed", t)
            }
        }
    }

    private fun emitWearState(wearing: Boolean) {
        val current = listener ?: return
        mainHandler.post {
            try {
                current.onWearState(wearing)
            } catch (t: Throwable) {
                Log.w(TAG, "listener onWearState failed", t)
            }
        }
    }

    private fun emitPhoneLockStateIfChanged(force: Boolean) {
        val locked: Boolean
        synchronized(lock) {
            val now = SystemClock.elapsedRealtime()
            if (!force && now - lastPhoneLockCheckAtMs < 1_000) return
            lastPhoneLockCheckAtMs = now
            locked = keyguardManager != null && keyguardManager.isDeviceLocked
            val value = if (locked) 1 else 0
            if (!force && value == phoneLockState) return
            phoneLockState = value
        }
        val current = listener ?: return
        mainHandler.post {
            try {
                current.onPhoneLockState(locked)
            } catch (t: Throwable) {
                Log.w(TAG, "listener onPhoneLockState failed", t)
            }
        }
    }

    private fun emitBatteryState(headsetBattery: Int, headsetCharging: Int) {
        val reportedRingBattery = ringBattery
        val reportedRingCharging = ringCharging
        val current = listener ?: return
        mainHandler.post {
            try {
                current.onBatteryState(headsetBattery, headsetCharging, reportedRingBattery, reportedRingCharging)
            } catch (t: Throwable) {
                Log.w(TAG, "listener onBatteryState failed", t)
            }
        }
    }

    private fun emitFirmwareInfo(info: BleProtocol.FirmwareInfo) {
        val current = listener ?: return
        mainHandler.post {
            try {
                current.onFirmwareInfo(info.leftVersion, info.rightVersion, info.extension)
            } catch (t: Throwable) {
                Log.w(TAG, "listener onFirmwareInfo failed", t)
            }
        }
    }

    private fun emitFrameMetrics(paintMs: Int, transmitMs: Int, tileCount: Int) {
        val current = listener ?: return
        mainHandler.post {
            try {
                current.onFrameMetrics(paintMs, transmitMs, tileCount)
            } catch (t: Throwable) {
                Log.w(TAG, "listener onFrameMetrics failed", t)
            }
        }
    }

    private fun maybeEmitEvenAppConflictLocked(reason: String?) {
        if ("write failed" != reason) {
            return
        }
        val now = SystemClock.elapsedRealtime()
        if (lastSessionReadyAtMs <= 0 || now - lastSessionReadyAtMs > ConnectionOptions.EVEN_APP_WRITE_FAILURE_WINDOW_MS) {
            return
        }
        if (lastEvenAppConflictAtMs > 0 && now - lastEvenAppConflictAtMs < 60_000) {
            return
        }
        if (!FaceclawEvenAppDetector.isEvenNotificationActive(appContext)) {
            return
        }
        lastEvenAppConflictAtMs = now
        emitEvenAppConflict("The Even Realities app still appears to be running. It can hold the glasses BLE link and cause Faceclaw write failures. Open its app settings and force stop it, then reconnect Faceclaw.")
    }

    private fun emitEvenAppConflict(message: String?) {
        val current = listener ?: return
        val messageSnapshot = message ?: ""
        mainHandler.post {
            try {
                current.onEvenAppConflict(messageSnapshot)
            } catch (t: Throwable) {
                Log.w(TAG, "listener onEvenAppConflict failed", t)
            }
        }
    }

    private fun setStateDisplay(nextPhase: String, nextStatus: String) {
        synchronized(lock) {
            phase = nextPhase
            status = nextStatus
        }
        emitState()
    }

    private fun emitState() {
        val current = listener ?: return
        val phaseSnapshot: String
        val statusSnapshot: String
        synchronized(lock) {
            phaseSnapshot = phase
            statusSnapshot = status
        }
        mainHandler.post {
            try {
                current.onStateChange(phaseSnapshot, statusSnapshot)
            } catch (t: Throwable) {
                Log.w(TAG, "listener onStateChange failed", t)
            }
        }
    }

    private fun updateG2ScreenWakeLock(screenOn: Boolean) {
        if (screenOn) {
            var wakeLock = g2ScreenWakeLock
            if (wakeLock == null) {
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, G2_SCREEN_WAKE_LOCK_TAG)
                wakeLock.setReferenceCounted(false)
                g2ScreenWakeLock = wakeLock
            }
            if (!wakeLock.isHeld) {
                wakeLock.acquire()
                logLine("G2 screen wake lock acquired")
            }
            return
        }
        releaseG2ScreenWakeLock()
    }

    private fun releaseG2ScreenWakeLock() {
        val wakeLock = g2ScreenWakeLock
        if (wakeLock != null && wakeLock.isHeld) {
            wakeLock.release()
            logLine("G2 screen wake lock released")
        }
    }

    private fun logLine(line: String) {
        Log.i(TAG, line)
    }

    private fun nextMapSessionId(): Int {
        val id = nextMapSessionId
        val increment = if (connectionOptions.skipSessionIds) 2 else 1
        nextMapSessionId = (nextMapSessionId + increment) and 0xff
        return id
    }

    private fun hasRingAddress(): Boolean {
        return ringAddress.trim().isNotEmpty()
    }

    private fun isConfiguredRingAddress(address: String?): Boolean {
        return hasRingAddress() && address != null && address.equals(ringAddress, ignoreCase = true)
    }

    private fun isDirectRingNotification(address: String?, characteristicUuid: String?): Boolean {
        if (!isConfiguredRingAddress(address) || characteristicUuid == null) {
            return false
        }
        return BleProtocol.R1_PHONE_NOTIFY_CHAR_UUID == characteristicUuid
            || BleProtocol.R1_NOTIFY_CHAR_UUID == characteristicUuid
    }

    private fun getDesiredFingerprint(): String {
        synchronized(desiredTilesLock) {
            return desiredFingerprint
        }
    }
}
