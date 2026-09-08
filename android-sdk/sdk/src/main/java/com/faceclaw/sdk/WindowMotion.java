package com.faceclaw.sdk;

/** Window-motion contract v1. Pure geometry/lifecycle; retains no app content. */
public final class WindowMotion {
    public static final int FRAME_INTERVAL_MS = 40;
    public static final int DURATION_MS = 360;
    public static final double BODY_REVEAL_PROGRESS = 0.9;
    public static final class Rect {
        public final double x, y, width, height;
        public Rect(double x, double y, double width, double height) {
            if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(width) || !Double.isFinite(height) || width <= 0 || height <= 0)
                throw new IllegalArgumentException("A finite, positive-size rectangle is required");
            this.x = x; this.y = y; this.width = width; this.height = height;
        }
    }
    public static final class Frame {
        public final Rect rect;
        public final double progress;
        public final boolean bodyVisible, closing, done;
        private Frame(Rect rect, double progress, boolean closing) {
            this.rect = rect; this.progress = progress; this.closing = closing;
            bodyVisible = !closing && progress >= BODY_REVEAL_PROGRESS; done = progress >= 1;
        }
    }
    private Rect from, to, lastRect;
    private boolean closing, active = true;
    private long started = -1;
    public WindowMotion(Rect from, Rect to, boolean closing) {
        if (from == null || to == null) throw new IllegalArgumentException("Rectangles required");
        this.from = from; this.to = to; this.lastRect = from; this.closing = closing;
    }
    public Frame sample(long nowMs) {
        if (nowMs < 0) throw new IllegalArgumentException("A monotonic timestamp is required");
        if (!active) return null;
        if (started < 0) started = nowMs;
        double progress = clamp((double)(nowMs - started) / DURATION_MS);
        lastRect = interpolate(from, to, progress);
        Frame frame = new Frame(lastRect, progress, closing);
        if (frame.done) active = false;
        return frame;
    }
    public void retarget(Rect target, boolean closing) {
        if (target == null) throw new IllegalArgumentException("Target required");
        from = lastRect; to = target; this.closing = closing; started = -1; active = true;
    }
    public void cancel() { active = false; }
    public boolean isRunning() { return active; }
    public Rect lastRect() { return lastRect; }
    public static Rect interpolate(Rect from, Rect to, double progress) {
        double horizontal = ease(progress / .78), vertical = ease((progress - .1) / .9);
        return new Rect(Math.floor(from.x + (to.x - from.x) * horizontal + .5), Math.floor(from.y + (to.y - from.y) * vertical + .5),
                Math.max(1, Math.floor(from.width + (to.width - from.width) * horizontal + .5)), Math.max(2, Math.floor(from.height + (to.height - from.height) * vertical + .5)));
    }
    private static double clamp(double value) { return Math.max(0, Math.min(1, value)); }
    private static double ease(double value) { return 1 - Math.pow(1 - clamp(value), 3); }
}
