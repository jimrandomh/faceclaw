package com.faceclaw.app;

import android.content.Context;

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
public final class FaceclawPreviewCompositor {
    private final Context appContext;
    private final SurfaceCompositor compositor = new SurfaceCompositor();
    private final android.os.Handler mainHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    // Notified (on the main looper, where the phone UI's JS runs) after each
    // applied surface frame, standing in for the BLE path's per-frame metrics
    // callback so the phone mirror refreshes promptly instead of waiting for
    // its safety-net poll.
    private volatile Runnable frameListener;

    // Active animated-GIF screen recording, or null when idle. Frames are
    // pushed by recordScreenFrame(), which the TS side calls at each
    // phone-preview flush.
    private volatile GifScreenRecorder screenRecorder;

    // Worker-app isolates locate their frame target through a static, like
    // FaceclawBleCommunicator.getActive(); Java statics are shared across
    // isolates, unlike anything on the JS side.
    private static volatile FaceclawPreviewCompositor activeInstance;

    public static FaceclawPreviewCompositor getActive() {
        return activeInstance;
    }

    public FaceclawPreviewCompositor(Context context) {
        this.appContext = context.getApplicationContext();
    }

    /** Publish this compositor as the workers' frame target. */
    public void makeActive() {
        activeInstance = this;
    }

    /** Withdraw from workers (a real connection is taking over). */
    public void release() {
        if (activeInstance == this) {
            activeInstance = null;
        }
        frameListener = null;
    }

    public void setFrameListener(Runnable listener) {
        this.frameListener = listener;
    }

    /** Set the compositor's output frame size. Call before configuring surfaces. */
    public void configureCompositorScreen(int width, int height) {
        compositor.configureScreen(width, height);
    }

    public void configureSurface(String id, int x, int y, int width, int height, int zOrder, int transparency) {
        compositor.configureSurface(id, x, y, width, height, zOrder, transparency);
    }

    public void removeSurface(String id) {
        compositor.removeSurface(id);
    }

    public void setSurfaceVisible(String id, boolean visible) {
        compositor.setSurfaceVisible(id, visible);
    }

    /** Blank (screen off) or unblank the output; retained surface state survives. */
    public void setScreenBlanked(boolean blanked) {
        compositor.setBlanked(blanked);
    }

    /**
     * Apply an update to one compositor surface. Unlike the connected path
     * there is no desired-frame store or transmit pipeline downstream; the
     * preview/screenshot calls recomposite the retained state on demand, so
     * applying the update is the whole job and the frame finishes here.
     */
    public void submitSurfaceFrame(
            java.nio.ByteBuffer pixels8bpp,
            String surfaceId,
            int rectX,
            int rectY,
            int rectWidth,
            int rectHeight,
            String contentFingerprint,
            int paintMs,
            int frameId,
            java.nio.ByteBuffer glyphs
    ) {
        compositor.applyAndComposite(
                surfaceId, pixels8bpp, rectX, rectY, rectWidth, rectHeight, contentFingerprint, glyphs);
        FrameTimings.getInstance().finishFrame(frameId, "composited (preview-only, no glasses)");
        Runnable listener = frameListener;
        if (listener != null) {
            mainHandler.post(listener);
        }
    }

    /**
     * The current composited screen as a phone-UI preview bitmap, or null
     * before any surface has been configured.
     */
    public android.graphics.Bitmap getCompositePreviewBitmap(double brightenGamma, boolean green) {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return null;
        }
        return PreviewBitmapUtil.fromGray(
                java.nio.ByteBuffer.wrap(composite.gray), composite.width, composite.height, brightenGamma, green);
    }

    /** Save the current composite as a 4-bit grayscale PNG; returns the path or "". */
    public String saveCompositePngScreenshot() throws java.io.IOException {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return "";
        }
        return ScreenshotUtil.savePngScreenshot(appContext, composite.gray, composite.width, composite.height);
    }

    /**
     * Save the current composite cropped to the given screen rect (the region
     * the shell says is actually occupied). The rect is clamped to the screen;
     * a degenerate rect falls back to the full screen.
     */
    public String saveCompositePngScreenshot(int cropX, int cropY, int cropWidth, int cropHeight)
            throws java.io.IOException {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return "";
        }
        int x = Math.max(0, cropX);
        int y = Math.max(0, cropY);
        int width = Math.min(composite.width - x, cropWidth - (x - cropX));
        int height = Math.min(composite.height - y, cropHeight - (y - cropY));
        if (width <= 0 || height <= 0 || (x == 0 && y == 0 && width == composite.width && height == composite.height)) {
            return ScreenshotUtil.savePngScreenshot(appContext, composite.gray, composite.width, composite.height);
        }
        byte[] cropped = new byte[width * height];
        for (int row = 0; row < height; row++) {
            System.arraycopy(composite.gray, (y + row) * composite.width + x, cropped, row * width, width);
        }
        return ScreenshotUtil.savePngScreenshot(appContext, cropped, width, height);
    }

    /** Begin collecting composite frames for an animated-GIF screen recording. */
    public void startScreenRecording() {
        screenRecorder = new GifScreenRecorder();
    }

    /** Capture the current composite into the active recording; no-op when idle. */
    public void recordScreenFrame() {
        GifScreenRecorder recorder = screenRecorder;
        if (recorder == null) {
            return;
        }
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return;
        }
        recorder.addFrame(composite.gray, composite.width, composite.height, System.currentTimeMillis());
    }

    /** Finish the recording and save it as an animated GIF; returns the path or "". */
    public String stopScreenRecording() throws java.io.IOException {
        GifScreenRecorder recorder = screenRecorder;
        screenRecorder = null;
        if (recorder == null) {
            return "";
        }
        return recorder.save(appContext);
    }
}
