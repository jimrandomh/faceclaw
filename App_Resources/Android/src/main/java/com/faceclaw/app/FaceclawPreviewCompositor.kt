package com.faceclaw.app

import android.content.Context

/**
 * Headless display target for preview-only mode (no glasses paired). Hosts
 * the same SurfaceCompositor the BLE communicator uses, so the TS side can
 * run its full surface/render pipeline unchanged; composited frames simply
 * have nowhere to go, and the phone-mirror preview, screenshots, and GIF
 * recordings read the retained composite back exactly as they do on a live
 * connection.
 *
 * The method signatures mirror the display subset of FaceclawBleCommunicator
 * (the TS DisplayTarget interface is typed against that subset).
 */
class FaceclawPreviewCompositor(context: Context) {
    private val appContext: Context = context.applicationContext
    private val compositor = SurfaceCompositor()
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

    // Notified (on the main looper, where the phone UI's JS runs) after each
    // applied surface frame, standing in for the BLE path's per-frame metrics
    // callback so the phone mirror refreshes promptly instead of waiting for
    // its safety-net poll.
    @Volatile private var frameListener: Runnable? = null

    // Active animated-GIF screen recording, or null when idle. Frames are
    // pushed by recordScreenFrame(), which the TS side calls at each
    // phone-preview flush.
    @Volatile private var screenRecorder: GifScreenRecorder? = null

    companion object {
        // Worker-app isolates locate their frame target through a static, like
        // FaceclawBleCommunicator.getActive(); Java statics are shared across
        // isolates, unlike anything on the JS side.
        @Volatile private var activeInstance: FaceclawPreviewCompositor? = null

        @JvmStatic
        fun getActive(): FaceclawPreviewCompositor? {
            return activeInstance
        }
    }

    /** Publish this compositor as the workers' frame target. */
    fun makeActive() {
        activeInstance = this
    }

    /** Withdraw from workers (a real connection is taking over). */
    fun release() {
        if (activeInstance === this) {
            activeInstance = null
        }
        frameListener = null
    }

    fun setFrameListener(listener: Runnable?) {
        this.frameListener = listener
    }

    /** Set the compositor's output frame size. Call before configuring surfaces. */
    fun configureCompositorScreen(width: Int, height: Int) {
        compositor.configureScreen(width, height)
    }

    fun configureSurface(id: String?, x: Int, y: Int, width: Int, height: Int, zOrder: Int, transparency: Int) {
        compositor.configureSurface(id, x, y, width, height, zOrder, transparency)
    }

    fun removeSurface(id: String) {
        compositor.removeSurface(id)
    }

    /** Dim every surface below zOrder belowZOrder to factor256/256 (see SurfaceCompositor). */
    fun submitShellScene(bytes: java.nio.ByteBuffer, paintMs: Int, frameId: Int) {
        compositor.setShellScene(AndroidByteReader(bytes))
        FrameTimings.getInstance().finishFrame(frameId, "composited (preview-only, no glasses)")
        val listener = frameListener
        if (listener != null) mainHandler.post(listener)
    }

    fun setUnderlayDim(belowZOrder: Int, factor256: Int) {
        compositor.setUnderlayDim(belowZOrder, factor256)
    }

    fun setSurfaceVisible(id: String, visible: Boolean) {
        compositor.setSurfaceVisible(id, visible)
    }

    fun setSurfaceDepth(id: String, depth: Int) {
        compositor.setSurfaceDepth(id, depth)
    }

    /** Blank (screen off) or unblank the output; retained surface state survives. */
    fun setScreenBlanked(blanked: Boolean) {
        compositor.setBlanked(blanked)
    }

    /**
     * Apply an update to one compositor surface. Unlike the connected path
     * there is no desired-frame store or transmit pipeline downstream; the
     * preview/screenshot calls recomposite the retained state on demand, so
     * applying the update is the whole job and the frame finishes here.
     */
    fun submitSurfaceFrame(
            pixels8bpp: java.nio.ByteBuffer,
            surfaceId: String,
            rectX: Int,
            rectY: Int,
            rectWidth: Int,
            rectHeight: Int,
            contentFingerprint: String,
            paintMs: Int,
            frameId: Int,
            glyphs: java.nio.ByteBuffer?
    ) {
        compositor.submitSurface(
                surfaceId, AndroidByteReader(pixels8bpp), rectX, rectY, rectWidth, rectHeight, contentFingerprint,
                if (glyphs == null) null else AndroidByteReader(glyphs))
        FrameTimings.getInstance().finishFrame(frameId, "composited (preview-only, no glasses)")
        val listener = frameListener
        if (listener != null) {
            mainHandler.post(listener)
        }
    }

    /**
     * The current composited screen as a phone-UI preview bitmap, or null
     * before any surface has been configured.
     */
    fun getCompositePreviewBitmap(brightenGamma: Double, green: Boolean): android.graphics.Bitmap? {
        val composite = compositor.previewComposite()
        if (composite == null) {
            return null
        }
        return PreviewBitmapUtil.fromGray(
                java.nio.ByteBuffer.wrap(composite.gray), composite.width, composite.height, brightenGamma, green)
    }

    /** Save the current composite as a 4-bit grayscale PNG; returns the path or "". */
    @Throws(java.io.IOException::class)
    fun saveCompositePngScreenshot(): String {
        val composite = compositor.previewComposite()
        if (composite == null) {
            return ""
        }
        return ScreenshotUtil.savePngScreenshot(appContext, composite.gray, composite.width, composite.height)
    }

    /**
     * Save the current composite cropped to the given screen rect (the region
     * the shell says is actually occupied). The rect is clamped to the screen;
     * a degenerate rect falls back to the full screen.
     */
    @Throws(java.io.IOException::class)
    fun saveCompositePngScreenshot(cropX: Int, cropY: Int, cropWidth: Int, cropHeight: Int): String {
        val composite = compositor.previewComposite()
        if (composite == null) {
            return ""
        }
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
        val recorder = screenRecorder
        if (recorder == null) {
            return
        }
        val composite = compositor.previewComposite()
        if (composite == null) {
            return
        }
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
        return recorder.save(appContext)
    }
}
