package com.faceclaw.sdk;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

/** Optional main-looper driver. One pending tick; SDK bitmap submission coalesces delivery. */
public final class WindowAnimator {
    public interface Renderer { void onFrame(WindowMotion.Frame frame); }
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Renderer renderer;
    private WindowMotion motion;
    private Runnable pending;
    private long generation;
    public WindowAnimator(Renderer renderer) {
        if (renderer == null) throw new IllegalArgumentException("Renderer required");
        this.renderer = renderer;
    }
    public void start(WindowMotion.Rect from, WindowMotion.Rect to, boolean closing) {
        cancel(); motion = new WindowMotion(from, to, closing); drive();
    }
    public void retarget(WindowMotion.Rect to, boolean closing) {
        requireMain();
        if (motion == null) throw new IllegalStateException("Start a transition first");
        unschedule(); motion.retarget(to, closing); drive();
    }
    public void cancel() { requireMain(); unschedule(); if (motion != null) motion.cancel(); motion = null; }
    public boolean isRunning() { return motion != null && motion.isRunning(); }
    private void unschedule() { generation++; if (pending != null) main.removeCallbacks(pending); pending = null; }
    private void drive() {
        final long epoch = generation, started = SystemClock.uptimeMillis();
        pending = new Runnable() {
            public void run() {
                if (epoch != generation || motion == null) return;
                WindowMotion.Frame frame = motion.sample(SystemClock.uptimeMillis());
                if (frame == null) { pending = null; return; }
                try { renderer.onFrame(frame); } catch (RuntimeException error) { if (epoch == generation) cancel(); throw error; }
                if (epoch != generation) return;
                if (frame.done) { pending = null; return; }
                long elapsed = SystemClock.uptimeMillis() - started;
                long next = Math.min(WindowMotion.DURATION_MS, (elapsed / WindowMotion.FRAME_INTERVAL_MS + 1) * WindowMotion.FRAME_INTERVAL_MS);
                main.postDelayed(this, Math.max(0, next - elapsed));
            }
        };
        pending.run();
    }
    private static void requireMain() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Animation must run on the main thread");
    }
}
