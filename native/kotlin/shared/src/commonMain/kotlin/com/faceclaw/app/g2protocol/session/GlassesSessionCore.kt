package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.jvm.JvmField

/**
 * The Faceclaw glasses session: connect/auth/prelude, the send scheduler and CFW
 * message window, the image pipeline, and every EvenHub/CFW control the app
 * drives. Platform-neutral; GATT goes through [SessionLink], side effects
 * through [SessionHost], clocks/locks through [ProtocolPlatform]. The worker
 * thread that runs [run] is started by the host from [start].
 *
 * The class body holds the state and the public API; the scheduler, image
 * pipeline and control helpers are extension functions in the sibling files
 * (GlassesSessionSend.kt, GlassesSessionControls.kt), which is why the state is
 * `internal` rather than private.
 *
 * Locking: [monitor] guards session state (reentrant); its wait sites are the
 * public blocking waits and the connect settling sleep, each of which holds the
 * lock exactly once. [desiredTilesLock] guards the desired-frame slot and is
 * taken inside the monitor where both are needed.
 */
class GlassesSessionCore(
    internal val link: SessionLink,
    internal val host: SessionHost,
    internal val frameTimings: FrameTimingsCore,
    internal val platform: ProtocolPlatform,
    rightAddress: String?,
    leftAddress: String?,
    ringAddress: String?,
) : FaceclawBleListener {
    companion object {
        const val TAG = "FaceclawComm"

        /** Relay-frame signature ('A','N') checked by [rawFrameTap]. */
        internal const val RELAY_TAG_A: Byte = 0x41
        internal const val RELAY_TAG_N: Byte = 0x4e

        // Local metadata for custom-command bookkeeping, not an EvenHub container.
        // Submitted frames supply pixel geometry; the stock layout only captures input.
        internal val DASHBOARD_TILE: BleProtocol.ImageTileOptions =
            BleProtocol.ImageTileOptions("img00", 10, 0, 0, 576, 288)

        internal const val FACECLAW_WAKE_LEASE_RENEW_MS = 45_000L
        internal const val FACECLAW_WAKE_CONTROL_WAIT_MS = 1_500L
        internal const val CFW_CLEANUP_WAIT_MS = 4_000L
        internal const val COMPASS_REPORT_INTERVAL_MS = 100
        internal const val COMPASS_MIN_CHANGE_DEGREES = 0

        // A timed-out benchmark message aborts the run, but its already-in-flight
        // peers still time out one by one; keep the window comfortably below
        // MAX_CONSECUTIVE_ACK_TIMEOUTS so a dead run can't escalate into a
        // transport-failure reconnect all by itself.
        internal const val BENCHMARK_MAX_WINDOW = 6

        internal fun chargingStatusText(battery: Int): String {
            return if (battery >= 0)
                "Glasses charging. Battery $battery%."
            else
                "Glasses charging."
        }

        internal fun timestamp(elapsedMs: Long): String {
            val wallMs = currentTimeMillis()
            return formatLocalTime(wallMs, "yyyy-MM-dd HH:mm:ss.SSS") + " elapsed=${elapsedMs}ms"
        }

        private fun requireAddress(name: String, address: String?): String {
            if (address == null || address.trim().isEmpty()) {
                throw IllegalArgumentException("$name is required")
            }
            return address.trim()
        }

        internal fun hex(data: ByteArray?): String {
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
            return out.concatToString()
        }

        internal fun safeMessage(t: Throwable?): String {
            if (t == null) {
                return "unknown"
            }
            val trace = t.stackTraceToString()
            if (trace.trim().isNotEmpty()) {
                return trace
            }
            val message = t.message
            return if (message == null || message.trim().isEmpty()) t.toString() else message
        }
    }

    internal val interruptibleSleep = InterruptibleSleep(platform)
    internal val monitor = SessionMonitor(platform)
    internal val rightAddress: String = requireAddress("rightAddress", rightAddress)
    internal val leftAddress: String = requireAddress("leftAddress", leftAddress)
    internal val ringAddress: String = ringAddress?.trim() ?: ""

    @Volatile internal var listener: FaceclawBleCommunicatorListener? = null

    /**
     * Optional tap for relay frames the session does not interpret: notifications on the
     * right arm's data characteristic whose first two bytes are 'A','N' (the iOS ANCS
     * notification relay, consumed by the phone-side ANCS client). Unset (Android) they
     * fall through to the normal frame parser exactly as before. Called on the BLE thread.
     */
    @Volatile internal var rawFrameTap: ((ByteArray) -> Unit)? = null
    internal val imuListeners = CopyOnWriteList<FaceclawImuListener>(platform)
    /** A compass subscriber plus the dispatcher it registered from (see addCompassListener). */
    internal class CompassSubscription(
        @JvmField val listener: FaceclawCompassListener,
        @JvmField val dispatcher: SessionDispatcher,
    )

    internal val compassSubscriptions = CopyOnWriteList<CompassSubscription>(platform)
    internal val ambientLightListeners = CopyOnWriteList<FaceclawAmbientLightListener>(platform)
    internal val micStatusListeners = CopyOnWriteList<FaceclawMicStatusListener>(platform)
    @Volatile internal var running = false
    @Volatile internal var userDisconnectRequested = false
    // Set when a connect attempt failed while an arm's OS bond is gone:
    // retrying is pointless until the user re-pairs, so the worker loop parks
    // instead of redialing. Cleared by start() (a fresh explicit connect).
    @Volatile internal var reconnectHalted = false

    internal var phase = "disconnected"
    internal var status = "Disconnected."

    internal var rightConnected = false
    internal var leftConnected = false
    internal var ringConnected = false
    internal var ringNotificationsReady = false
    internal var sessionReady = false
    internal var fixedLayoutCreated = false
    internal var shutdownRequested = false
    // CFW firmware-debug-flags overlay (mode 7). Desired value pushed from TS; the
    // sub-op last sent this session (-1 = not yet), reset on (re)connect so the
    // overlay state is re-asserted on every reconnect and whenever the value changes.
    @Volatile internal var firmwareDebugFlagsEnabled = false
    internal var firmwareDebugFlagsLastSent = -1
    // Desired CFW mode-10 compass state. It survives reconnects; lastSent is
    // reset with each session so an open Compass window is re-asserted.
    /**
     * Who currently wants the stock compass running (the Compass window, the
     * Navigate worker, ...). The magnetometer is one shared resource, so it
     * stays on while any owner holds it and is released when the last lets go;
     * this keeps one app's release from silently switching off another's feed.
     */
    internal val compassOwners: MutableSet<String?> = HashSet()
    internal var compassControlLastSent = -1
    // Whether the glasses-side compass may still be running: set when an enable
    // is enqueued, cleared only when a disable is acked. Drives the forced
    // disable sent ahead of an EvenHub shutdown/suspend, since a pending
    // disable can be wiped by the shutdown's queue flush and the retry loop
    // does not run while shutdownRequested (magnetometer left on = battery drain).
    internal var compassMaybeOn = false
    internal var startupProbePending = false
    // Desired ownership of CFW's fail-open stock-wake lease (dashboard launch
    // and Even AI foreground takeover). This survives a transport reconnect;
    // the lease itself is volatile firmware state and is re-acquired once both
    // arms are ready.
    internal var faceclawWakeLeaseEnabled = false
    internal var lastFaceclawWakeLeaseQueuedAtMs = 0L
    internal var faceclawWakeControlGeneration = 0
    internal var faceclawWakeControlSentCount = 0
    internal var lastFaceclawFramebufferLeaseQueuedAtMs = 0L
    internal var faceclawFramebufferControlGeneration = 0
    internal var faceclawFramebufferControlSentCount = 0
    internal var faceclawWakePendingNonce = -1
    /**
     * The last firmware-info read said the glasses run Faceclaw's custom
     * firmware. Gates the private modes (cleanup, resource cache, ...) so stock
     * or third-party firmware never sees them; the TS side checks the actual
     * revision and disconnects on a mismatch, so no per-feature gating is
     * needed here.
     */
    internal var customFirmwareDetected = false
    internal val brightnessPolicy = BrightnessPolicy()
    internal var brightnessSentVisible: Boolean? = null
    internal var brightnessSentLevel = -1
    internal var brightnessAlsStartedAt = -2000L
    internal var brightnessDemoPolling = false
    internal var cfwCleanupDelivered = false
    internal var lastCfwCleanupAckMagic = 0

    internal var reconnectAfterMs = 0L
    internal var ringReconnectAfterMs = 0L
    internal var lastAckAtMs = 0L
    internal var lastIncomingAtMs = 0L
    internal var lastHeartbeatSentAtMs = 0L
    internal var lastHeartbeatAckedAtMs = 0L
    internal var lastConnectionOrInputAtMs = 0L
    internal var lastBatteryRefreshAtMs = 0L
    internal var imageRetryAfterMs = 0L
    internal var lastSessionReadyAtMs = 0L
    internal var lastEvenAppConflictAtMs = 0L
    internal var consecutiveAckTimeouts = 0
    internal var lastAudioControlAckMagic = 0

    internal val connectionOptions = ConnectionOptions()
    internal val magicPool = BleMagicPool(platform)
    internal val messageBuilder = MessageBuilder(magicPool)
    internal var nextTransportSeq = 0x40
    internal var nextMapSessionIdValue = 0
    internal var nextImageUpdateId = 1
    // Wire frame id for mode-3 deltas (CFW reorder/skip/dup diagnostic). uint16,
    // advanced by 1 per emitted delta; kept in [1, 0xfffe] to avoid the CFW's
    // 0xffff "empty" sentinel.
    internal var nextImageFrameId = 1
    internal var lastShutdownAckMagic = 0
    internal var lastShutdownExitAtMs = 0L
    internal var headsetBattery = -1
    internal var headsetCharging = -1
    internal var ringBattery = -1
    internal var ringCharging = -1
    // Silent mode: 1 = on, 0 = off, -1 = not yet known. See updateSilentModeLocked.
    internal var silentMode = -1
    internal var wearState = -1
    internal var phoneLockState = -1
    internal var lastPhoneLockCheckAtMs = 0L
    internal var audioCaptureActive = false
    internal var firmwareInfoQueried = false
    // Glasses are in the charging case: nobody is wearing them, so display
    // communication pauses and only battery polls flow (see driveSession).
    internal var chargingMode = false
    @Volatile internal var audioPacketListener: FaceclawAudioPacketListener? = null

    // BLE bandwidth benchmark (Developer app). Streams no-op image payloads
    // (CFW mode 7 with an unused sub-op: parsed, acked, and discarded — stock
    // firmware likewise ignores unknown image modes) for a fixed duration with
    // a selectable message size and pipeline window, then reports throughput.
    // While active, desired-frame sends are held back and heartbeats are
    // satisfied by the benchmark's own acks, so the stream is the only image
    // traffic. All state below is guarded by `monitor`; results are read with
    // getBandwidthBenchmarkStatus() and survive until the next run starts.
    internal var benchmarkActive = false
    internal var benchmarkAborted = false
    internal var benchmarkMessageSize = 0
    internal var benchmarkWindowSize = 0
    internal var benchmarkDurationMs = 0
    internal var benchmarkLinkMode = 0
    internal var benchmarkLinkPending = false
    internal var benchmarkReadyAtMs = 0L
    internal var benchmarkStartAtMs = 0L     // first benchmark write; 0 until then
    internal var benchmarkDeadlineAtMs = 0L  // start + duration; MAX_VALUE until first write
    internal var benchmarkLastAckAtMs = 0L
    internal var benchmarkEndAtMs = 0L       // 0 while running; set when the run drains
    internal var benchmarkMessagesSent = 0
    internal var benchmarkMessagesAcked = 0
    internal var benchmarkTimeouts = 0
    internal var benchmarkPayloadBytesAcked = 0L
    internal var benchmarkWireBytesAcked = 0L

    internal var displayedFingerprint = ""
    // The frame the firmware shadow will hold once the current image pipeline
    // drains: the most recently ENQUEUED image (headerless packed 4bpp, see
    // BmpUtil.pack4bppFromGray8), which is the correct base for the next delta
    // when frames are pipelined. Set at enqueue; cleared whenever the image
    // pipeline is cleared (clearAllMessagesLocked / clearMessagesOfKindLocked
    // "image"), so it is only ever read while it holds a valid current-session base.
    internal var lastEnqueuedPacked: ByteArray = ByteArray(0)
    internal var lastEnqueuedWidth = 0
    internal var lastEnqueuedHeight = 0
    internal var lastEnqueuedFingerprint = ""
    internal val imageUpdateStats: MutableMap<Int, BleImageOptimizer.ImageUpdateStats> = HashMap()

    internal val desiredTilesLock: ProtocolLock = platform.createLock()
    internal var desiredFingerprint = ""
    // Headerless packed 4bpp frame (see BmpUtil.pack4bppFromGray8) plus its
    // pixel dimensions.
    internal var desiredPacked: ByteArray? = ByteArray(0)
    internal var desiredWidth = 0
    internal var desiredHeight = 0
    internal var desiredPaintMs = 0
    internal var desiredFrameId = 0
    // Screen-space deferred draws (glyphs + images) whose pixels are baked
    // into desiredPacked; the resource-cache planner may replay them as
    // on-glasses cached draws.
    internal var desiredDraws: Array<SurfaceCompositor.ScreenDraw>? = arrayOf()
    // (frame, reason) of the last "waiting to send" line, so a frame that
    // stalls for seconds records one line per state change (see
    // noteImageStallLocked). Send-loop thread only.
    internal var stallFrameId = 0
    internal var stallReason = ""
    // Highest compositor sequence stored as the desired frame; composites that
    // lost a store race to a newer one are discarded (their content is already
    // included in the newer composite).
    internal var lastStoredCompositeSeq = 0L

    // Wire submissions need screenGray + the shell scene, never preview pixels.
    // Preview/screenshot/recording callers render those explicitly on demand.
    internal val compositor = SurfaceCompositor(false)

    // Phone-side model of the CFW's 192 KiB resource cache.
    // Reset whenever the image pipeline / EvenHub session is torn down: the
    // firmware frees the cache with the fb lease, and after any resync the
    // cheap safe assumption is an empty cache (glyphs re-upload lazily).
    internal val resourceCache = ResourceCacheState()
    internal val scenePlanner = ScenePlanner(resourceCache)
    internal var desiredShellScene: ShellScene = ShellScene.EMPTY

    internal val pendingMessages = ArrayDeque<OutboundMessage>()
    internal val cfwTransports = arrayOf(CfwTransport(platform), CfwTransport(platform))
    internal val inFlightMessages = ArrayDeque<OutboundMessage>()
    internal var prewrittenMessage: OutboundMessage? = null
    internal var prewrittenFrames: List<ByteArray> = emptyList()

    internal fun now(): Long = platform.elapsedRealtimeMs()

    internal fun logLine(line: String) = host.log(SessionLogLevel.INFO, TAG, line, null)

    internal fun logDebug(line: String) = host.log(SessionLogLevel.DEBUG, TAG, line, null)

    internal fun logWarn(line: String, error: Throwable? = null) = host.log(SessionLogLevel.WARN, TAG, line, error)

    internal fun logError(line: String) = host.log(SessionLogLevel.ERROR, TAG, line, null)

    // ---------------------------------------------------------------------
    // Lifecycle

    /** See [rawFrameTap]; null restores the default (frames parsed by the session). */
    fun setRawFrameTap(tap: ((ByteArray) -> Unit)?) {
        rawFrameTap = tap
    }

    /**
     * Write one already-framed packet to an arm outside the message scheduler (the ANCS
     * relay client builds its own packets). Blocks like any link write; false when the
     * arm is unknown, the link rejects the write, or the session is not running.
     */
    fun writeRawPacket(arm: String, packet: ByteArray): Boolean {
        val address = when (arm.uppercase()) {
            "R", "RIGHT" -> rightAddress
            "L", "LEFT" -> leftAddress
            else -> return false
        }
        val active = monitor.withLock { running }
        if (!active) return false
        return try {
            link.writeFrames(address, BleProtocol.WRITE_CHAR_UUID, listOf(packet), ConnectionOptions.WRITE_MODE,
                ConnectionOptions.WRITE_TIMEOUT_MS)
        } catch (t: Throwable) {
            logLine("raw packet write failed: " + safeMessage(t))
            false
        }
    }

    fun setListener(listener: FaceclawBleCommunicatorListener?) {
        this.listener = listener
        emitState()
        emitPhoneLockStateIfChanged(true)
    }

    /** Start the worker (through the host); false when it was already running. */
    fun start(): Boolean {
        monitor.withLock {
            if (running) {
                return false
            }
            running = true
            userDisconnectRequested = false
            reconnectHalted = false
            shutdownRequested = false
            host.startWorker { run() }
            return true
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
        monitor.withLock {
            userDisconnectRequested = true
            running = false
            audioCaptureActive = false
            audioPacketListener = null
        }
        setStateDisplay("disconnecting", "Disconnecting...")
        interruptibleSleep.interrupt()
        host.joinWorker(5_000)
        monitor.withLock {
            resetSessionStateLocked()
            clearAllMessagesLocked("disconnect")
            // Unknown until the next connection's first push or settings poll.
            silentMode = -1
        }
        link.disconnect(rightAddress)
        link.disconnect(leftAddress)
        if (hasRingAddress()) {
            link.disconnect(ringAddress)
        }
        link.close()
        host.setScreenWakeLock(false)
        setStateDisplay("disconnected", "Disconnected.")
    }

    fun close() {
        disconnect()
        for (transport in cfwTransports) transport.close()
    }

    /** The platform's screen-on/off/user-present signal: refresh the lock state and wake the worker. */
    fun onPhoneLockSignal() {
        emitPhoneLockStateIfChanged(true)
        interruptibleSleep.interrupt()
    }

    fun setG2ScreenOn(screenOn: Boolean) {
        host.postToMain { host.setScreenWakeLock(screenOn) }
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
        monitor.withLock {
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
        monitor.withLock {
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
        monitor.withLock {
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
        monitor.withLock {
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
        monitor.withLock {
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
        val deadline = now() + maxOf(0, timeoutMs)
        var readyGeneration = 0
        monitor.withLock {
            while (running && sessionReady) {
                var frameReady = false
                desiredTilesLock.locked {
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
                val remaining = deadline - now()
                if (remaining <= 0) {
                    return false
                }
                monitor.awaitMs(minOf(remaining, 100L))
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
        monitor.withLock {
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
        monitor.withLock {
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

    /** Update desired brightness; retained before readiness and across reconnect. */
    fun setBrightness(autoAdjust: Boolean, brightnessLevel: Int) {
        monitor.withLock {
            brightnessPolicy.setMode(autoAdjust, brightnessLevel)
        }
        interruptibleSleep.interrupt()
    }

    fun configureBrightness(auto: Boolean, level: Int, minimum: Int, maximum: Int, curve: String, fadeMs: Int) {
        monitor.withLock { brightnessPolicy.configure(auto, level, minimum, maximum, curve, fadeMs) }
        interruptibleSleep.interrupt()
    }

    /**
     * Enable the stock wear detector, then ask CFW to emit its current cached
     * state. The queue order matters: the query must run after the setting is
     * applied, including on a fresh install where wear detection was disabled.
     */
    fun enableWearDetectionAndRequestState() {
        monitor.withLock {
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

    // ---------------------------------------------------------------------
    // Bandwidth benchmark

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
        monitor.withLock {
            if (benchmarkActive || !running || !sessionReady || !fixedLayoutCreated
                    || shutdownRequested || chargingMode) {
                logLine("skip bandwidth benchmark; already running or image path not ready")
                return false
            }
            benchmarkMessageSize = maxOf(2, minOf(messageSize, ConnectionOptions.IMAGE_FRAGMENT_SIZE))
            benchmarkWindowSize = maxOf(1, minOf(windowSize, BENCHMARK_MAX_WINDOW))
            benchmarkDurationMs = maxOf(1_000, durationMs)
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
        monitor.withLock {
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
        monitor.withLock {
            val state = if (benchmarkActive)
                (if (benchmarkStartAtMs == 0L) "starting" else "running")
            else
                (if (benchmarkEndAtMs != 0L) "done" else "idle")
            val end = if (benchmarkActive) now() else benchmarkEndAtMs
            val elapsed = if (benchmarkStartAtMs == 0L) 0L else maxOf(0L, end - benchmarkStartAtMs)
            try {
                val status = linkedMapOf<String, Any?>()
                status["state"] = state
                status["messageSize"] = benchmarkMessageSize
                status["windowSize"] = benchmarkWindowSize
                status["linkMode"] = benchmarkLinkMode
                status["elapsedMs"] = elapsed
                status["messagesSent"] = benchmarkMessagesSent
                status["messagesAcked"] = benchmarkMessagesAcked
                status["timeouts"] = benchmarkTimeouts
                status["payloadBytesAcked"] = benchmarkPayloadBytesAcked
                status["wireBytesAcked"] = benchmarkWireBytesAcked
                status["aborted"] = benchmarkAborted
                return Json.write(status)
            } catch (e: Exception) {
                return "{\"state\":\"idle\"}"
            }
        }
    }

    // ---------------------------------------------------------------------
    // Sensor and status listeners

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

    /** Request one CFW ambient-light report (image-handler mode 16 op 0). */
    fun queryAmbientLight() {
        monitor.withLock {
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
        // The brightness controller owns passive mode throughout a CFW session.
        // The demo can request faster samples without releasing that ownership.
        if (customFirmwareDetected) {
            monitor.withLock { brightnessDemoPolling = enable; brightnessAlsStartedAt = -2000 }
            interruptibleSleep.interrupt()
            return
        }
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
        monitor.withLock {
            clearMessagesOfKindLocked("als-control")
            enqueueAmbientLightControlLocked(payload, "als polling " + (if (enable) "start" else "stop"), true)
        }
        interruptibleSleep.interrupt()
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
        monitor.withLock {
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
        monitor.withLock {
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
        monitor.withLock {
            audioPacketListener = null
            audioCaptureActive = false
            logLine("G2 audio forwarding disabled")
        }
    }

    /**
     * Subscribe to compass events. Callbacks are delivered on the dispatcher of
     * the thread that registered (falling back to the main thread), so app
     * worker isolates can listen without a cross-thread hop into their JS.
     */
    fun addCompassListener(listener: FaceclawCompassListener?) {
        if (listener == null) {
            return
        }
        compassSubscriptions.add(CompassSubscription(listener, host.currentThreadDispatcher()))
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

    // ---------------------------------------------------------------------
    // Compositor entry points (pixels arrive as ByteReaders; the platform
    // adapter wraps its native buffers without copying)

    /** Set the compositor's output frame size. Call before configuring surfaces. */
    fun configureCompositorScreen(width: Int, height: Int) {
        compositor.configureScreen(width, height)
    }

    /** The current composite for previews/screenshots, or null before any surface exists. */
    fun previewComposite(): SurfaceCompositor.Composite? = compositor.previewComposite()

    /**
     * Show or hide a compositor surface, immediately submitting the resulting
     * frame. Recompositing here (rather than waiting for the next surface
     * update) is what makes a just-foregrounded window's retained frame
     * actually appear — otherwise a static window (e.g. the terminal hub) whose
     * frame landed while briefly hidden would stay blank until its next repaint.
     */
    /** Stereo depth for a full-screen surface; applies from its next frame. */
    fun setSurfaceDepth(id: String, depth: Int) = compositor.setSurfaceDepth(id, depth)

    fun setSurfaceVisible(id: String, visible: Boolean) {
        // Its own frame: this recomposite is a real screen update with real
        // latency, and without one it would show up in other frames' logs only
        // as an anonymous "superseded by frame#0".
        val frameId = frameTimings.startFrame(
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
        val frameId = frameTimings.startFrame(
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
    fun submitShellScene(bytes: ByteReader, paintMs: Int, frameId: Int) {
        compositor.setShellScene(bytes)
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
     * identifies the surface's full content after the update. glyphs carries
     * the frame's glyph draws (see SurfaceCompositor's glyph overload for the
     * buffer format), or null when the submitter has no glyph metadata; the
     * pixels alone remain fully correct.
     */
    fun submitSurfaceFrame(
            pixels8bpp: ByteReader,
            surfaceId: String,
            rectX: Int,
            rectY: Int,
            rectWidth: Int,
            rectHeight: Int,
            contentFingerprint: String?,
            paintMs: Int,
            frameId: Int,
            glyphs: ByteReader?
    ) {
        logLine("Received an updated frame for surface $surfaceId")
        frameTimings.log(frameId, "surface " + surfaceId + " updated rect="
                + rectWidth + "x" + rectHeight + "+" + rectX + "+" + rectY
                + (if (glyphs == null) " (no glyph draws)" else ""))
        frameTimings.spanStart(frameId, "composite")
        val composite = compositor.applyAndComposite(
                surfaceId, pixels8bpp, rectX, rectY, rectWidth, rectHeight, contentFingerprint, glyphs)
        frameTimings.spanEnd(frameId, "composite")
        // Pack the composited 8bpp buffer down to the headerless 4bpp frame
        // format the wire planners consume; BMP framing is added later only for
        // the uncompressed fallback.
        frameTimings.spanStart(frameId, "pack-4bpp")
        val packed = BmpUtil.pack4bppFromGray8(composite.screenGray, composite.width, composite.height)
        frameTimings.spanEnd(frameId, "pack-4bpp")
        storeDesiredComposite(composite, packed, paintMs, frameId)
    }

    /** Store a composite as the desired frame unless a newer one won the race. */
    internal fun storeDesiredComposite(composite: SurfaceCompositor.Composite, packed: ByteArray, paintMs: Int, frameId: Int) {
        var supersededFrameId = 0
        var stale = false
        desiredTilesLock.locked {
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
        frameTimings.log(frameId, "image submitted as desired frame")
        interruptibleSleep.interrupt()
    }

    /**
     * Play a tone sequence via CFW load_image_z mode 5 kind 4. The payload is
     * the complete wire buffer ([5][4][nSteps][freqLo,freqHi,duty,msLo,msHi]*n,
     * up to 48 steps), built on the TS side; it rides the arbitrary-payload
     * image path like the other mode-5 controls.
     */
    fun playBuzzerSequence(bytes: ByteArray?) {
        monitor.withLock {
            if (!running || !sessionReady || !fixedLayoutCreated) {
                logLine("skip buzzer sequence; session not ready")
                return
            }
            if (bytes == null || bytes.size < 3) {
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

    // ---------------------------------------------------------------------
    // EvenHub page lifecycle

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
        monitor.withLock {
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
        val drainDeadline = now() + CFW_CLEANUP_WAIT_MS
        monitor.withLock {
            while (running && sessionReady && !inFlightMessages.isEmpty()) {
                val remaining = drainDeadline - now()
                if (remaining <= 0) break
                monitor.awaitMs(minOf(remaining, 100L))
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

        val deadline = now() + CFW_CLEANUP_WAIT_MS
        monitor.withLock {
            while (running
                    && sessionReady
                    && lastCfwCleanupAckMagic != magic
                    && hasPendingOrInflightMagicLocked(magic)) {
                val remaining = deadline - now()
                if (remaining <= 0) break
                monitor.awaitMs(minOf(remaining, 100L))
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
        monitor.withLock {
            resourceCache.reset()
        }
        if (sendShutdownInternal(0, false)) {
            return true
        }
        monitor.withLock {
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
        monitor.withLock {
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
        } catch (t: Throwable) {
            logLine("EvenHub resume prelude failed: " + safeMessage(t))
            handleTransportFailure("EvenHub resume prelude failed")
            return false
        }

        monitor.withLock {
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

    // ---------------------------------------------------------------------
    // Worker loop and inbound traffic

    /** The worker loop; runs on the thread the host started from [start]. */
    fun run() {
        logLine("communicator start R=$rightAddress L=$leftAddress ring=$ringAddress")
        while (true) {
            try {
                if (!running) {
                    logWarn("Exiting event looop")
                    break
                }
                emitPhoneLockStateIfChanged(false)
                if (!sessionReady) {
                    if (reconnectHalted) {
                        interruptibleSleep.sleep(ConnectionOptions.IDLE_SLEEP_MS.toLong())
                        continue
                    }
                    val now = now()
                    if (now < reconnectAfterMs) {
                        interruptibleSleep.sleep(minOf(ConnectionOptions.IDLE_SLEEP_MS.toLong(), reconnectAfterMs - now))
                        continue
                    }
                    logWarn("Attempting to connect")
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
                if (!running) {
                    // The host interrupted the worker to stop it (JVM thread
                    // interrupt surfacing from a wait); nothing to recover.
                    logLine("communicator loop interrupted while stopping: " + (t.message ?: t.toString()))
                    break
                }
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
        val uuid = characteristicUuid.lowercase()
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
            monitor.withLock {
                lastIncomingAtMs = now()
                for (ack in acks) {
                    for (message in inFlightMessages) {
                        val ingress = if (message.isLeftArmMessage) leftAddress else rightAddress
                        if (message.sid == CfwTransport.SID && address.equals(ingress, ignoreCase = true) && message.magic == ack.streamId) {
                            message.acceptCfwAck(ack)
                            logLine("CFW " + (if (ack.nack) "NACK" else "ACK") + " id=" + ack.streamId
                                    + " ordinal=" + ack.messageId + " lens=" + ack.lens + " txseq=" + (data[2].toInt() and 255)
                                    + " redundant=" + (ack !== acks[0])
                                    + " size=" + ack.size + " crc=" + ack.checksum
                                    + " expected=" + message.message.size + "/" + message.cfwChecksum
                                    + " ackedLenses=" + message.cfwAckLenses
                                    + " ageMs=" + (lastIncomingAtMs - message.sentAtMs))
                            message.ackPayload = data.copyOf()
                            break
                        }
                    }
                }
                drainCfwAcknowledgementsLocked()
            }
            interruptibleSleep.interrupt()
            return
        }
        val tap = rawFrameTap
        if (tap != null && data.size >= 2 && data[0] == RELAY_TAG_A && data[1] == RELAY_TAG_N
                && address.equals(rightAddress, ignoreCase = true)) {
            monitor.withLock { lastIncomingAtMs = now() }
            tap(data.copyOf())
            return
        }
        logDebug("onNotification: address=" + address + " characteristicUuid=" + characteristicUuid + " data.length=" + data.size)
        val frame = BleProtocol.parseFrame(data)
        val decodedWearState = BleProtocol.parseWearState(frame)
        val compassEvent = if (address.equals(rightAddress, ignoreCase = true))
            BleProtocol.parseCompassEvent(frame)
        else
            null
        var emitWearState = false
        var event: G2Event? = null
        monitor.withLock {
            lastIncomingAtMs = now()
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
                    if (address.equals(rightAddress, ignoreCase = true)) brightnessPolicy.sample(alsReport, now())
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
                                lastShutdownExitAtMs = now()
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
                val frameId = frameTimings.startFrame(
                    "input:" + finalEvent.kind + " type=" + finalEvent.eventType + " src=" + finalEvent.eventSource)
                frameTimings.log(frameId, "input event decoded from BLE notification")
                emitRingEvent(finalEvent, frameId)
            }
        }
    }

    internal fun handleDirectRingNotification(characteristicUuid: String, data: ByteArray) {
        val decoded = FaceclawRingEventDecoder.decode(data)
        if (decoded == null) {
            logDebug("direct ring notify ignored: characteristicUuid=" + characteristicUuid + " raw=" + hex(data))
            return
        }

        val event = decoded.event
        val arrivalMs = now()
        monitor.withLock {
            lastIncomingAtMs = arrivalMs
            lastConnectionOrInputAtMs = arrivalMs
        }
        logLine("direct ring " + decoded.label + " " + decoded.detail + " raw=" + hex(data))
        val frameId = frameTimings.startFrame("input:ring:" + decoded.label)
        frameTimings.log(frameId, "input event decoded from direct ring notification")
        emitRingEvent(event, frameId)
        interruptibleSleep.interrupt()
    }

    internal fun handleRenderNotification(address: String, data: ByteArray) {
        val listenerToCall: FaceclawAudioPacketListener?
        val arrivalMs = now()
        monitor.withLock {
            lastIncomingAtMs = arrivalMs
            listenerToCall = if (audioCaptureActive) audioPacketListener else null
        }
        if (listenerToCall == null) {
            return
        }
        val arm = if (address.equals(leftAddress, ignoreCase = true)) "L" else if (address.equals(rightAddress, ignoreCase = true)) "R" else "?"
        try {
            listenerToCall.onAudioPacket(data.copyOf(), arm, arrivalMs)
        } catch (t: Throwable) {
            logLine("G2 mic packet listener failed: " + safeMessage(t))
        }
    }

    override fun onConnectionStateChange(address: String?, connected: Boolean) {
        monitor.withLock {
            if (address == null) {
                return
            }
            if (isConfiguredRingAddress(address)) {
                ringConnected = connected
                ringNotificationsReady = false
                if (!connected) {
                    ringReconnectAfterMs = now() + ConnectionOptions.RING_RECONNECT_DELAY_MS
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
                    reconnectAfterMs = now() + ConnectionOptions.RECONNECT_DELAY_MS
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

    // ---------------------------------------------------------------------
    // Connect sequence (worker thread)

    internal fun connectLoopOnce() {
        setStateDisplay("connecting", "Connecting to the glasses...")
        try {
            connectArm(rightAddress, true)
            connectArm(leftAddress, true)
            if (!sleepDuringConnectSettling(800)) {
                return
            }
            authenticateArms()
            sendPrelude()

            monitor.withLock {
                sessionReady = true
                // A fresh transport prelude always starts an active EvenHub
                // lifecycle, even if the previous connection dropped while
                // its page was intentionally suspended.
                shutdownRequested = false
                fixedLayoutCreated = false
                clearAllMessagesLocked("session ready")
                displayedFingerprint = ""
                lastAckAtMs = now()
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
            monitor.withLock {
                // Query settings promptly on the first session so firmware
                // version/extension (and battery) arrive without waiting for
                // the input-quiet battery poll. The settings response doubles as
                // the firmware-compatibility check surfaced during onboarding.
                if (!firmwareInfoQueried) {
                    firmwareInfoQueried = true
                    lastBatteryRefreshAtMs = now()
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

    internal fun sleepDuringConnectSettling(delayMs: Long): Boolean {
        val deadline = now() + delayMs
        monitor.withLock {
            while (running && !userDisconnectRequested) {
                val remaining = deadline - now()
                if (remaining <= 0) {
                    return true
                }
                monitor.awaitMs(minOf(remaining, 100L))
            }
            return false
        }
    }

    internal fun connectArm(address: String, enableRenderNotify: Boolean) {
        if (!link.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw IllegalStateException("connect failed: $address")
        }
        // requestConnectionPriority has no callback in this Android compile target, so there is
        // no reliable completion point to keep it in the global GATT operation pipeline. But it's
        // important enough for performance that we call it anyways.
        link.requestHighPriority(address)

        link.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS)

        if (!link.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw IllegalStateException("discoverServices failed: $address")
        }
        if (!link.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw IllegalStateException("enableNotifications failed: " + address + " " + BleProtocol.NOTIFY_CHAR_UUID)
        }
        if (enableRenderNotify) {
            link.enableNotifications(address, BleProtocol.RENDER_NOTIFY_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)
        }
        monitor.withLock {
            if (address.equals(rightAddress, ignoreCase = true)) {
                rightConnected = true
            } else if (address.equals(leftAddress, ignoreCase = true)) {
                leftConnected = true
            }
        }
    }

    internal fun shouldAttemptRingConnect(): Boolean {
        if (!hasRingAddress()) {
            return false
        }
        val now = now()
        monitor.withLock {
            return running
                && sessionReady
                && !ringNotificationsReady
                && now >= ringReconnectAfterMs
                && pendingMessages.isEmpty()
                && inFlightMessages.isEmpty()
        }
    }

    internal fun tryConnectRing(reason: String) {
        if (!hasRingAddress()) {
            return
        }
        try {
            connectRing()
        } catch (t: Throwable) {
            monitor.withLock {
                ringConnected = false
                ringNotificationsReady = false
                ringReconnectAfterMs = now() + ConnectionOptions.RING_RECONNECT_DELAY_MS
            }
            logLine("direct ring connect failed (" + reason + "): " + safeMessage(t))
        }
    }

    internal fun connectRing() {
        logLine("connecting direct ring $ringAddress")
        if (!link.connect(ringAddress, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw IllegalStateException("connect failed: $ringAddress")
        }

        link.requestHighPriority(ringAddress)
        link.requestMtu(ringAddress, ConnectionOptions.RING_DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS)

        if (!link.discoverServices(ringAddress, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw IllegalStateException("discoverServices failed: $ringAddress")
        }

        val phoneNotify = enableRingNotification(BleProtocol.R1_PHONE_NOTIFY_CHAR_UUID)
        val dataNotify = enableRingNotification(BleProtocol.R1_NOTIFY_CHAR_UUID)
        if (!phoneNotify && !dataNotify) {
            throw IllegalStateException("no R1 notify characteristic subscribed")
        }

        monitor.withLock {
            ringConnected = true
            ringNotificationsReady = true
            ringReconnectAfterMs = 0
        }
        logLine("direct ring ready phoneNotify=$phoneNotify dataNotify=$dataNotify")
    }

    internal fun enableRingNotification(characteristicUuid: String): Boolean {
        try {
            return link.enableNotifications(
                ringAddress,
                characteristicUuid,
                true,
                ConnectionOptions.DESCRIPTOR_TIMEOUT_MS
            )
        } catch (t: Throwable) {
            logDebug("direct ring notify subscribe skipped: " + characteristicUuid + " " + safeMessage(t))
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
    internal fun authenticateArms() {
        val right = messageBuilder.securityAuth(false)
        val left = messageBuilder.securityAuth(true)
        val now = now()
        for (message in arrayOf(right, left)) {
            message.onAck = MessageCallback {
            }
            message.onTimeout = MessageCallback {
            }
            message.sentAtMs = now
            writeMessage(message)
        }
        val deadline = now() + ConnectionOptions.SECURITY_AUTH_SOFT_TIMEOUT_MS
        while (running && !userDisconnectRequested && !inFlightMessages.isEmpty()) {
            val done = monitor.withLock {
                !running || userDisconnectRequested || inFlightMessages.isEmpty()
            }
            if (done) {
                break
            }
            val remaining = deadline - now()
            if (remaining <= 0) {
                break
            }
            interruptibleSleep.sleep(minOf(remaining, 100L))
        }
        monitor.withLock {
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

    internal fun sendPrelude() {
        sendPrelude(false)
    }

    internal fun sendPrelude(preserveWakeLeaseControls: Boolean) {
        monitor.withLock {
            if (preserveWakeLeaseControls) {
                clearAllMessagesPreservingWakeLeaseLocked("prelude")
            } else {
                clearAllMessagesLocked("prelude")
            }
        }
        val now = now()
        val prelude = messageBuilder.prelude()
        prelude.onAck = MessageCallback {
        }
        prelude.onTimeout = MessageCallback {
            handleTransportFailure("ack timeout")
        }
        prelude.sentAtMs = now
        writeMessage(prelude)

        val deadline = now() + ConnectionOptions.PRELUDE_TIMEOUT_MS
        while (running && !userDisconnectRequested && !inFlightMessages.isEmpty()) {
            val done = monitor.withLock {
                !running || userDisconnectRequested || inFlightMessages.isEmpty()
            }
            if (done) {
                break
            }
            val remaining = deadline - now()
            if (remaining <= 0) {
                break
            }
            interruptibleSleep.sleep(minOf(remaining, 100L))
        }
        monitor.withLock {
            if (!inFlightMessages.isEmpty()) {
                clearInFlightMessagesLocked("prelude timeout")
                throw IllegalStateException("prelude ack timeout")
            }
        }
    }

    // ---------------------------------------------------------------------
    // Small helpers shared by the extension files

    internal fun nextMapSessionId(): Int {
        val id = nextMapSessionIdValue
        val increment = if (connectionOptions.skipSessionIds) 2 else 1
        nextMapSessionIdValue = (nextMapSessionIdValue + increment) and 0xff
        return id
    }

    internal fun hasRingAddress(): Boolean {
        return ringAddress.trim().isNotEmpty()
    }

    internal fun isConfiguredRingAddress(address: String?): Boolean {
        return hasRingAddress() && address != null && address.equals(ringAddress, ignoreCase = true)
    }

    internal fun isDirectRingNotification(address: String?, characteristicUuid: String?): Boolean {
        if (!isConfiguredRingAddress(address) || characteristicUuid == null) {
            return false
        }
        return BleProtocol.R1_PHONE_NOTIFY_CHAR_UUID == characteristicUuid
            || BleProtocol.R1_NOTIFY_CHAR_UUID == characteristicUuid
    }

    internal fun desiredFingerprintSnapshot(): String {
        desiredTilesLock.locked {
            return desiredFingerprint
        }
    }
}
