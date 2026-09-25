package com.faceclaw.app

import android.annotation.SuppressLint
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * Android facade over the shared [GlassesSessionCore]: the JVM API TypeScript
 * and the other Android classes call by name, plus the Android-only pieces:
 * the GATT link ([AndroidSessionLink] over [FaceclawBleManager]), main-thread
 * marshalling, the worker thread, the screen wake lock, keyguard/screen
 * broadcast state, the Even-app conflict check, and the Bitmap/ByteBuffer/
 * Context entry points for previews, screenshots and recordings.
 */
@SuppressLint("MissingPermission")
class FaceclawBleCommunicator(context: Context, rightAddress: String?, leftAddress: String?, ringAddress: String?) {
    companion object {
        private const val TAG = GlassesSessionCore.TAG
        private const val G2_SCREEN_WAKE_LOCK_TAG = "Faceclaw:G2Screen"

        // The most recently started communicator; lets app worker threads submit
        // surface frames without holding a cross-isolate reference to the bridge
        // object (JS wrappers do not cross isolates, but the Java instance does).
        @Volatile private var activeInstance: FaceclawBleCommunicator? = null

        @JvmStatic
        fun getActive(): FaceclawBleCommunicator? {
            return activeInstance
        }
    }

    private val appContext: Context = context.applicationContext
    init {
        FrameTimings.getInstance().init(appContext)
    }
    private val powerManager: PowerManager = appContext.getSystemService(Context.POWER_SERVICE) as PowerManager
    private val keyguardManager: KeyguardManager? = appContext.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager?
    private val bleManager: FaceclawBleManager = FaceclawBleManager(appContext)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val mainDispatcher = SessionDispatcher { action -> mainHandler.post { action() } }
    @Volatile private var workerThread: Thread? = null
    private var g2ScreenWakeLock: PowerManager.WakeLock? = null
    private var phoneLockReceiverRegistered = false

    private val host = object : SessionHost {
        override fun postToMain(action: () -> Unit) {
            mainHandler.post { action() }
        }

        override fun currentThreadDispatcher(): SessionDispatcher {
            val looper = Looper.myLooper() ?: return mainDispatcher
            val handler = Handler(looper)
            return SessionDispatcher { action -> handler.post { action() } }
        }

        override fun isPhoneLocked(): Boolean = keyguardManager != null && keyguardManager.isDeviceLocked

        override fun setScreenWakeLock(on: Boolean) = updateG2ScreenWakeLock(on)

        override fun isEvenAppActive(): Boolean = FaceclawEvenAppDetector.isEvenNotificationActive(appContext)

        override fun startWorker(body: () -> Unit) {
            val thread = Thread(body, "FaceclawBleCommunicator")
            workerThread = thread
            thread.start()
        }

        override fun joinWorker(timeoutMs: Long) {
            val threadToJoin = workerThread ?: return
            threadToJoin.interrupt()
            try {
                threadToJoin.join(timeoutMs)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
            workerThread = null
        }

        override fun log(level: SessionLogLevel, tag: String, message: String, error: Throwable?) {
            when (level) {
                SessionLogLevel.DEBUG -> Log.d(tag, message)
                SessionLogLevel.INFO -> Log.i(tag, message)
                SessionLogLevel.WARN -> if (error != null) Log.w(tag, message, error) else Log.w(tag, message)
                SessionLogLevel.ERROR -> if (error != null) Log.e(tag, message, error) else Log.e(tag, message)
            }
        }
    }

    private val core = GlassesSessionCore(
        AndroidSessionLink(bleManager),
        host,
        FrameTimings.getInstance().core,
        AndroidProtocolPlatform,
        rightAddress,
        leftAddress,
        ringAddress,
    )

    private val phoneLockReceiver: BroadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            core.onPhoneLockSignal()
        }
    }

    // Active animated-GIF screen recording, or null when idle. Frames are
    // pushed by recordScreenFrame(), which the TS side calls at each
    // phone-preview flush.
    @Volatile private var screenRecorder: GifScreenRecorder? = null

    init {
        bleManager.setListener(core)
        val phoneLockFilter = IntentFilter()
        phoneLockFilter.addAction(Intent.ACTION_SCREEN_ON)
        phoneLockFilter.addAction(Intent.ACTION_SCREEN_OFF)
        phoneLockFilter.addAction(Intent.ACTION_USER_PRESENT)
        appContext.registerReceiver(phoneLockReceiver, phoneLockFilter)
        phoneLockReceiverRegistered = true
    }

    fun setListener(listener: FaceclawBleCommunicatorListener?) = core.setListener(listener)

    fun start() {
        if (core.start()) {
            activeInstance = this
        }
    }

    fun disconnect() = core.disconnect()

    fun close() {
        if (activeInstance === this) {
            activeInstance = null
        }
        core.close()
        if (phoneLockReceiverRegistered) {
            phoneLockReceiverRegistered = false
            appContext.unregisterReceiver(phoneLockReceiver)
        }
    }

    fun setG2ScreenOn(screenOn: Boolean) = core.setG2ScreenOn(screenOn)

    fun setFirmwareDebugFlags(enabled: Boolean) = core.setFirmwareDebugFlags(enabled)

    fun startG2AudioCapture(listener: FaceclawAudioPacketListener?): Boolean = core.startG2AudioCapture(listener)

    fun stopG2AudioCapture() = core.stopG2AudioCapture()

    fun isSessionReady(): Boolean = core.isSessionReady()

    /** See [GlassesSessionCore.isAudioCaptureActive]. */
    fun isAudioCaptureActive(): Boolean = core.isAudioCaptureActive()

    fun setFaceclawWakeLeaseEnabled(enabled: Boolean): Boolean = core.setFaceclawWakeLeaseEnabled(enabled)

    fun awaitEvenHubSessionReady(timeoutMs: Int): Boolean = core.awaitEvenHubSessionReady(timeoutMs)

    fun setImuReportEnabled(enable: Boolean, reportFrq: Int) = core.setImuReportEnabled(enable, reportFrq)

    fun setCompassEnabled(enable: Boolean) = core.setCompassEnabled(enable)

    fun setCompassEnabled(owner: String?, enable: Boolean) = core.setCompassEnabled(owner, enable)

    fun setBrightness(autoAdjust: Boolean, brightnessLevel: Int) = core.setBrightness(autoAdjust, brightnessLevel)
    fun configureBrightness(auto: Boolean, level: Int, minimum: Int, maximum: Int, curve: String, fadeMs: Int) =
        core.configureBrightness(auto, level, minimum, maximum, curve, fadeMs)

    fun enableWearDetectionAndRequestState() = core.enableWearDetectionAndRequestState()

    fun startBandwidthBenchmark(messageSize: Int, windowSize: Int, durationMs: Int): Boolean =
        core.startBandwidthBenchmark(messageSize, windowSize, durationMs)

    // 0: current link; 1: re-request HIGH; 2: request 2M; 3: both.
    fun startBandwidthBenchmarkWithLinkMode(messageSize: Int, windowSize: Int,
                                            durationMs: Int, linkMode: Int): Boolean =
        core.startBandwidthBenchmarkWithLinkMode(messageSize, windowSize, durationMs, linkMode)

    fun cancelBandwidthBenchmark() = core.cancelBandwidthBenchmark()

    /** Status/results of the current or most recent benchmark run, as JSON. */
    fun getBandwidthBenchmarkStatus(): String = core.getBandwidthBenchmarkStatus()

    fun addImuListener(listener: FaceclawImuListener?) = core.addImuListener(listener)

    fun removeImuListener(listener: FaceclawImuListener?) = core.removeImuListener(listener)

    fun addAmbientLightListener(listener: FaceclawAmbientLightListener?) = core.addAmbientLightListener(listener)

    fun removeAmbientLightListener(listener: FaceclawAmbientLightListener?) = core.removeAmbientLightListener(listener)

    fun queryAmbientLight() = core.queryAmbientLight()

    fun setAmbientLightPolling(enable: Boolean, intervalMs: Int, minDelta: Int,
                               heartbeatMs: Int, bindToLease: Boolean) =
        core.setAmbientLightPolling(enable, intervalMs, minDelta, heartbeatMs, bindToLease)

    fun addMicStatusListener(listener: FaceclawMicStatusListener?) = core.addMicStatusListener(listener)

    fun removeMicStatusListener(listener: FaceclawMicStatusListener?) = core.removeMicStatusListener(listener)

    fun sendFaceclawMicControl(record: ByteArray?, label: String, rightTemple: Boolean, leftTemple: Boolean) =
        core.sendFaceclawMicControl(record, label, rightTemple, leftTemple)

    fun startG2AudioForwarding(listener: FaceclawAudioPacketListener?): Boolean = core.startG2AudioForwarding(listener)

    fun stopG2AudioForwarding() = core.stopG2AudioForwarding()

    fun addCompassListener(listener: FaceclawCompassListener?) = core.addCompassListener(listener)

    fun removeCompassListener(listener: FaceclawCompassListener?) = core.removeCompassListener(listener)

    /** Set the compositor's output frame size. Call before configuring surfaces. */
    fun configureCompositorScreen(width: Int, height: Int) = core.configureCompositorScreen(width, height)

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
        val composite = core.previewComposite() ?: return null
        return PreviewBitmapUtil.fromGray(
                java.nio.ByteBuffer.wrap(composite.gray), composite.width, composite.height, brightenGamma, green)
    }

    /** Save the current composite as a 4-bit grayscale PNG; returns the path or "". */
    @Throws(java.io.IOException::class)
    fun saveCompositePngScreenshot(): String {
        val composite = core.previewComposite() ?: return ""
        return ScreenshotUtil.savePngScreenshot(appContext, composite.gray, composite.width, composite.height)
    }

    /**
     * Save the current composite cropped to the given screen rect (the region
     * the shell says is actually occupied). The rect is clamped to the screen;
     * a degenerate rect falls back to the full screen.
     */
    @Throws(java.io.IOException::class)
    fun saveCompositePngScreenshot(cropX: Int, cropY: Int, cropWidth: Int, cropHeight: Int): String {
        val composite = core.previewComposite() ?: return ""
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
        val composite = core.previewComposite() ?: return
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
            Log.i(TAG, "screen recording hit its frame cap; the tail was dropped")
        }
        return recorder.save(appContext)
    }

    fun setSurfaceVisible(id: String, visible: Boolean) = core.setSurfaceVisible(id, visible)

    fun setSurfaceDepth(id: String, depth: Int) = core.setSurfaceDepth(id, depth)

    fun setScreenBlanked(blanked: Boolean) = core.setScreenBlanked(blanked)

    fun configureSurface(id: String?, x: Int, y: Int, width: Int, height: Int, zOrder: Int, transparency: Int) =
        core.configureSurface(id, x, y, width, height, zOrder, transparency)

    fun removeSurface(id: String) = core.removeSurface(id)

    /** Stage an immutable shell snapshot alongside the retained app screen. */
    fun submitShellScene(bytes: java.nio.ByteBuffer, paintMs: Int, frameId: Int) =
        core.submitShellScene(AndroidByteReader(bytes), paintMs, frameId)

    /** Legacy compositor dimming for callers without a shell scene. */
    fun setUnderlayDim(belowZOrder: Int, factor256: Int) = core.setUnderlayDim(belowZOrder, factor256)

    /**
     * Apply an update to one compositor surface and submit the recomposited
     * screen as the desired frame (see [GlassesSessionCore.submitSurfaceFrame]).
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

    /** As above, with the frame's glyph draws (null when the submitter has no glyph metadata). */
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
        core.submitSurfaceFrame(AndroidByteReader(pixels8bpp), surfaceId, rectX, rectY, rectWidth, rectHeight,
                contentFingerprint, paintMs, frameId, if (glyphs == null) null else AndroidByteReader(glyphs))
    }

    /** Play a tone sequence via CFW load_image_z mode 5 kind 4 (payload built on the TS side). */
    fun playBuzzerSequence(payload: java.nio.ByteBuffer?) {
        val bytes = ByteArray(if (payload == null) 0 else payload.remaining())
        if (payload != null) {
            payload.get(bytes)
        }
        core.playBuzzerSequence(bytes)
    }

    fun sendShutdown(exitMode: Int): Boolean = core.sendShutdown(exitMode)

    fun sendCfwCleanup(): Boolean = core.sendCfwCleanup()

    fun suspendEvenHubSession(): Boolean = core.suspendEvenHubSession()

    fun resumeEvenHubSession(): Boolean = core.resumeEvenHubSession()

    // ---------------------------------------------------------------------

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
                Log.i(TAG, "G2 screen wake lock acquired")
            }
            return
        }
        val wakeLock = g2ScreenWakeLock
        if (wakeLock != null && wakeLock.isHeld) {
            wakeLock.release()
            Log.i(TAG, "G2 screen wake lock released")
        }
    }
}
