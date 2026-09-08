package com.faceclaw.sdk;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

/** Optional app-side animation clock. It does not submit frames or own a host connection. */
public final class FrameAnimator {
    public interface Callback { void onFrame(float progress); }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Callback callback;
    private Runnable pending;
    private long generation;

    public FrameAnimator(Callback callback) {
        if (callback == null) throw new IllegalArgumentException("A frame callback is required");
        this.callback = callback;
    }

    /** Start or replace an animation. Call on the main thread and cancel when the window hides. */
    public void start(long durationMs) {
        requireMainThread();
        if (durationMs < 0 || durationMs > 10_000) throw new IllegalArgumentException("Duration must be 0..10000ms");
        cancel();
        final long epoch = generation;
        final long started = SystemClock.uptimeMillis();
        pending = new Runnable() {
            @Override public void run() {
                if (epoch != generation) return;
                long elapsed = SystemClock.uptimeMillis() - started;
                float progress = easedProgress(elapsed, durationMs);
                try {
                    callback.onFrame(progress);
                } catch (RuntimeException error) {
                    if (epoch == generation) cancel();
                    throw error;
                }
                // A callback may cancel or replace its own animation.
                if (epoch != generation) return;
                if (progress >= 1f) pending = null;
                else main.postDelayed(this, Math.min(40, Math.max(1, durationMs - elapsed)));
            }
        };
        pending.run();
    }

    public void cancel() {
        requireMainThread();
        generation++;
        if (pending != null) main.removeCallbacks(pending);
        pending = null;
    }

    public boolean isRunning() { return pending != null; }

    /** Smooth interpolation also available to applications with their own frame clock. */
    public static float easedProgress(long elapsedMs, long durationMs) {
        if (durationMs <= 0 || elapsedMs >= durationMs) return 1f;
        if (elapsedMs <= 0) return 0f;
        float t = (float) elapsedMs / durationMs;
        return t * t * (3f - 2f * t);
    }

    private static void requireMainThread() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Animation must run on the main thread");
    }
}
