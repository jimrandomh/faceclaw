@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import platform.Foundation.NSData
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue
import platform.darwin.dispatch_queue_create

/** iPhone-notification relay hooks; both callbacks are delivered on the main queue. */
interface IosAncsListener {
    fun onAncsAuthorization(authorized: Boolean)

    /** A relay frame ('A','N',...) received on the right arm's data characteristic. */
    fun onRelayFrame(data: NSData)
}

/**
 * ObjC-facing facade over the shared [GlassesSessionCore] for the NativeScript app: the iOS
 * counterpart of Android's FaceclawBleCommunicator with the same method names. GATT goes
 * through [IosBleCentral], side effects through [IosSessionHost]; every listener the
 * TypeScript side installs is invoked on the main queue. Binary crossings use NSData.
 */
class IosGlassesSession internal constructor(
    link: SessionLink,
    private val central: IosBleCentral?,
    private val host: SessionHost,
    rightAddress: String,
    leftAddress: String,
    ringAddress: String,
    platform: ProtocolPlatform,
) {
    /** Production constructor: CoreBluetooth link + main-queue host. Addresses are peripheral identifiers. */
    constructor(rightAddress: String, leftAddress: String, ringAddress: String) : this(
        IosBleCentral(),
        rightAddress,
        leftAddress,
        ringAddress,
    )

    private constructor(central: IosBleCentral, rightAddress: String, leftAddress: String, ringAddress: String) : this(
        central,
        central,
        IosSessionHost(),
        rightAddress,
        leftAddress,
        ringAddress,
        IosProtocolPlatform,
    )

    companion object {
        const val TAG = GlassesSessionCore.TAG
    }

    private val frameTimings = IosFrameTimings.shared.core
    private val core = GlassesSessionCore(link, host, frameTimings, platform, rightAddress, leftAddress, ringAddress)
    private val rawQueue = dispatch_queue_create("com.faceclaw.session.raw", null)
    private val rightIdentifier = rightAddress.uppercase()

    init {
        central?.setSessionListener(core)
    }

    // ----- lifecycle ------------------------------------------------------------------

    fun setListener(listener: FaceclawBleCommunicatorListener?) = core.setListener(listener)

    fun start(): Boolean = core.start()

    fun disconnect() = core.disconnect()

    fun close() = core.close()

    fun onPhoneLockSignal() = core.onPhoneLockSignal()

    fun isSessionReady(): Boolean = core.isSessionReady()

    // ----- iPhone notification relay (ANCS) -------------------------------------------------

    /** Ask CoreBluetooth for ANCS on the right arm's next connection (call before start()). */
    fun setRequiresAncs(required: Boolean) {
        central?.setRequiresAncs(rightIdentifier, required)
    }

    fun isAncsAuthorized(): Boolean = central?.isAncsAuthorized(rightIdentifier) ?: false

    fun setAncsListener(listener: IosAncsListener?) {
        if (listener == null) {
            core.setRawFrameTap(null)
            central?.setAncsAuthorizationListener(null)
            return
        }
        core.setRawFrameTap { bytes ->
            val data = bytes.data()
            dispatch_async(dispatch_get_main_queue()) { listener.onRelayFrame(data) }
        }
        central?.setAncsAuthorizationListener { _, authorized ->
            dispatch_async(dispatch_get_main_queue()) { listener.onAncsAuthorization(authorized) }
        }
    }

    /** Queue one relay packet for the right arm; never blocks the caller (writes run on a serial queue). */
    fun writeRawToRight(packet: NSData) {
        val bytes = packet.byteArray()
        dispatch_async(rawQueue) {
            if (!core.writeRawPacket("R", bytes)) PlatformLog.w(TAG, "relay packet dropped (${bytes.size} bytes)")
        }
    }

    // ----- controls -------------------------------------------------------------------

    fun setG2ScreenOn(screenOn: Boolean) = core.setG2ScreenOn(screenOn)

    fun setFirmwareDebugFlags(enabled: Boolean) = core.setFirmwareDebugFlags(enabled)

    /** The packet listener is invoked on the main queue (the core delivers on the BLE queue). */
    fun startG2AudioCapture(listener: FaceclawAudioPacketListener?): Boolean =
        core.startG2AudioCapture(listener?.let { MainQueueAudioListener(it) })

    fun stopG2AudioCapture() = core.stopG2AudioCapture()

    fun isAudioCaptureActive(): Boolean = core.isAudioCaptureActive()

    fun setFaceclawWakeLeaseEnabled(enabled: Boolean): Boolean = core.setFaceclawWakeLeaseEnabled(enabled)

    fun awaitEvenHubSessionReady(timeoutMs: Int): Boolean = core.awaitEvenHubSessionReady(timeoutMs)

    fun setImuReportEnabled(enable: Boolean, reportFrq: Int) = core.setImuReportEnabled(enable, reportFrq)

    fun setCompassEnabled(enable: Boolean) = core.setCompassEnabled(enable)

    fun setCompassEnabledForOwner(owner: String?, enable: Boolean) = core.setCompassEnabled(owner, enable)

    fun setBrightness(autoAdjust: Boolean, brightnessLevel: Int) = core.setBrightness(autoAdjust, brightnessLevel)

    fun enableWearDetectionAndRequestState() = core.enableWearDetectionAndRequestState()

    fun startBandwidthBenchmark(messageSize: Int, windowSize: Int, durationMs: Int): Boolean =
        core.startBandwidthBenchmark(messageSize, windowSize, durationMs)

    fun startBandwidthBenchmarkWithLinkMode(messageSize: Int, windowSize: Int, durationMs: Int, linkMode: Int): Boolean =
        core.startBandwidthBenchmarkWithLinkMode(messageSize, windowSize, durationMs, linkMode)

    fun cancelBandwidthBenchmark() = core.cancelBandwidthBenchmark()

    fun getBandwidthBenchmarkStatus(): String = core.getBandwidthBenchmarkStatus()

    fun addImuListener(listener: FaceclawImuListener?) = core.addImuListener(listener)

    fun removeImuListener(listener: FaceclawImuListener?) = core.removeImuListener(listener)

    fun addAmbientLightListener(listener: FaceclawAmbientLightListener?) = core.addAmbientLightListener(listener)

    fun removeAmbientLightListener(listener: FaceclawAmbientLightListener?) = core.removeAmbientLightListener(listener)

    fun queryAmbientLight() = core.queryAmbientLight()

    fun setAmbientLightPolling(enable: Boolean, intervalMs: Int, minDelta: Int, heartbeatMs: Int, bindToLease: Boolean) =
        core.setAmbientLightPolling(enable, intervalMs, minDelta, heartbeatMs, bindToLease)

    fun addMicStatusListener(listener: FaceclawMicStatusListener?) = core.addMicStatusListener(listener)

    fun removeMicStatusListener(listener: FaceclawMicStatusListener?) = core.removeMicStatusListener(listener)

    fun sendFaceclawMicControl(record: NSData?, label: String, rightTemple: Boolean, leftTemple: Boolean) =
        core.sendFaceclawMicControl(record?.byteArray(), label, rightTemple, leftTemple)

    fun startG2AudioForwarding(listener: FaceclawAudioPacketListener?): Boolean =
        core.startG2AudioForwarding(listener?.let { MainQueueAudioListener(it) })

    fun stopG2AudioForwarding() = core.stopG2AudioForwarding()

    /** Compass events are delivered on the queue of the thread that adds the listener (main for TypeScript). */
    fun addCompassListener(listener: FaceclawCompassListener?) = core.addCompassListener(listener)

    fun removeCompassListener(listener: FaceclawCompassListener?) = core.removeCompassListener(listener)

    fun sendShutdown(exitMode: Int): Boolean = core.sendShutdown(exitMode)

    fun sendCfwCleanup(): Boolean = core.sendCfwCleanup()

    fun suspendEvenHubSession(): Boolean = core.suspendEvenHubSession()

    fun resumeEvenHubSession(): Boolean = core.resumeEvenHubSession()

    fun playBuzzerSequence(payload: NSData?) = core.playBuzzerSequence(payload?.byteArray())

    // ----- surfaces -------------------------------------------------------------------

    /** Set the compositor's output frame size. Call before configuring surfaces. */
    fun configureCompositorScreen(width: Int, height: Int) = core.configureCompositorScreen(width, height)

    fun setSurfaceVisible(id: String, visible: Boolean) = core.setSurfaceVisible(id, visible)

    fun setScreenBlanked(blanked: Boolean) = core.setScreenBlanked(blanked)

    fun configureSurface(id: String, x: Int, y: Int, width: Int, height: Int, zOrder: Int, transparency: Int) =
        core.configureSurface(id, x, y, width, height, zOrder, transparency)

    fun removeSurface(id: String) = core.removeSurface(id)

    fun submitShellScene(bytes: NSData, paintMs: Int, frameId: Int) = core.submitShellScene(IosByteReader(bytes), paintMs, frameId)

    fun setUnderlayDim(belowZOrder: Int, factor256: Int) = core.setUnderlayDim(belowZOrder, factor256)

    fun submitSurfaceFrame(
        pixels8bpp: NSData,
        surfaceId: String,
        rectX: Int,
        rectY: Int,
        rectWidth: Int,
        rectHeight: Int,
        contentFingerprint: String?,
        paintMs: Int,
        frameId: Int,
        glyphs: NSData?,
    ) = core.submitSurfaceFrame(
        IosByteReader(pixels8bpp), surfaceId, rectX, rectY, rectWidth, rectHeight, contentFingerprint, paintMs, frameId,
        glyphs?.let { IosByteReader(it) },
    )

    /** The current composited screen (gray, 8bpp) or null before any surface was configured. */
    fun previewComposite(): IosTextureFrame? = core.previewComposite()?.let { IosTextureFrame(it) }

    fun compositeWidth(): Int = core.previewComposite()?.width ?: 0

    fun compositeHeight(): Int = core.previewComposite()?.height ?: 0

    /** The current composite as a 4-bit grayscale PNG, or null. */
    fun screenshotPng(): NSData? {
        val composite = core.previewComposite() ?: return null
        return SharedScreenshots.encode4BitGrayPng(composite.gray, composite.width, composite.height).data()
    }

    /** Frame-timings export text (see FrameTimingsCore), for the phone-side debug page. */
    fun frameTimingsExport(): String = frameTimings.buildExport()

    internal fun coreForTests(): GlassesSessionCore = core

    private class MainQueueAudioListener(private val delegate: FaceclawAudioPacketListener) : FaceclawAudioPacketListener {
        override fun onAudioPacket(data: ByteArray?, arm: String?, arrivalMs: Long) {
            dispatch_async(dispatch_get_main_queue()) { delegate.onAudioPacket(data, arm, arrivalMs) }
        }
    }
}
