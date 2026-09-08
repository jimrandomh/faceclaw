'use strict';
// Faceclaw window-motion contract v1. Kept in parity with WindowMotion.java.
const FRAME_INTERVAL_MS = 40;
const DURATION_MS = 360;
const BODY_REVEAL_PROGRESS = 0.9;
const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => 1 - (1 - clamp(value)) ** 3;
function rect(value) {
  if (!value || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) || value.width <= 0 || value.height <= 0) throw new RangeError('A finite, positive-size rectangle is required');
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}
function interpolateRect(from, to, progress) {
  const horizontal = ease(progress / 0.78), vertical = ease((progress - 0.1) / 0.9);
  return { x: Math.round(from.x + (to.x - from.x) * horizontal), y: Math.round(from.y + (to.y - from.y) * vertical),
    width: Math.max(1, Math.round(from.width + (to.width - from.width) * horizontal)), height: Math.max(2, Math.round(from.height + (to.height - from.height) * vertical)) };
}
/** No timers or bitmaps. Sample from a monotonic clock; missed samples are skipped. */
class WindowMotion {
  constructor(from, to, closing = false) { this.from = rect(from); this.to = rect(to); this.closing = closing; this.started = null; this.lastRect = { ...this.from }; this.active = true; }
  sample(now) {
    if (!Number.isFinite(now) || now < 0) throw new RangeError('A monotonic timestamp is required');
    if (!this.active) return null;
    if (this.started === null) this.started = now;
    const progress = clamp((now - this.started) / DURATION_MS);
    this.lastRect = interpolateRect(this.from, this.to, progress);
    const done = progress >= 1;
    if (done) this.active = false;
    return { rect: { ...this.lastRect }, progress, bodyVisible: !this.closing && progress >= BODY_REVEAL_PROGRESS, closing: this.closing, done };
  }
  /** Reverse/retarget from the last submitted geometry, never a future computed frame. */
  retarget(to, closing) { this.from = { ...this.lastRect }; this.to = rect(to); this.closing = closing; this.started = null; this.active = true; }
  cancel() { this.active = false; }
}
/** At most one pending callback; its renderer reads the latest state when it runs. */
class FrameRequest {
  constructor(render, schedule = callback => setTimeout(callback, 0), unschedule = handle => clearTimeout(handle)) { this.render = render; this.schedule = schedule; this.unschedule = unschedule; this.pending = null; this.epoch = 0; }
  request() { if (this.pending !== null) return; const epoch = this.epoch; this.pending = this.schedule(() => { if (epoch !== this.epoch) return; this.pending = null; this.render(); }); }
  cancel() { this.epoch++; if (this.pending !== null) this.unschedule(this.pending); this.pending = null; }
}
/** Optional driver for apps without their own render loop. Clock/timers are injectable. */
class WindowAnimator {
  constructor(render, options = {}) {
    this.render = render; this.now = options.now || (() => typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
    this.unschedule = options.unschedule || (handle => clearTimeout(handle));
    this.motion = null; this.pending = null; this.epoch = 0;
  }
  start(from, to, closing = false) { this.cancel(); this.motion = new WindowMotion(from, to, closing); this.drive(); }
  retarget(to, closing) { if (!this.motion) throw new Error('Start a transition first'); this.stopTick(); this.motion.retarget(to, closing); this.drive(); }
  stopTick() { this.epoch++; if (this.pending !== null) this.unschedule(this.pending); this.pending = null; }
  cancel() { this.stopTick(); this.motion?.cancel(); this.motion = null; }
  isRunning() { return !!this.motion?.active; }
  drive() {
    const epoch = this.epoch, started = this.now();
    const tick = () => {
      if (epoch !== this.epoch || !this.motion) return;
      this.pending = null;
      const frame = this.motion.sample(this.now()); if (!frame) return;
      try { this.render(frame); } catch (error) { if (epoch === this.epoch) this.cancel(); throw error; }
      if (epoch !== this.epoch || frame.done) return;
      const elapsed = this.now() - started;
      const next = Math.min(DURATION_MS, (Math.floor(elapsed / FRAME_INTERVAL_MS) + 1) * FRAME_INTERVAL_MS);
      this.pending = this.schedule(tick, Math.max(0, next - elapsed));
    };
    tick();
  }
}
module.exports = { FRAME_INTERVAL_MS, DURATION_MS, BODY_REVEAL_PROGRESS, interpolateRect, WindowMotion, FrameRequest, WindowAnimator };
