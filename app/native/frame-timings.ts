/**
 * TS-side wrapper for the Java FrameTimings singleton (per-frame latency
 * instrumentation; see FrameTimings.java). Frame ID 0 means "no frame" and is
 * ignored by every method, so callers never need to null-check.
 *
 * Frames form a tree: pass the causing frame's ID as `parentFrameId` when one
 * frame fans out into several (an input event that repaints both the focused
 * app and the shell chrome), and the export nests them under one timeline
 * instead of showing unrelated frames.
 *
 * Because each JS context is single-threaded, this module also tracks a
 * "current frame" so that leaf drawing/IO code can record spans without
 * threading a frame ID through every call signature.
 */

declare const com: any;

let javaInstance: any = null;
let javaUnavailable = false;
// Fallback IDs when the Java class is unavailable (e.g. unit tests): negative
// so they can never collide with real Java-issued frame IDs.
let fallbackNextFrameId = -1;
let currentFrameId = 0;

function getJava(): any {
  if (javaInstance === null && !javaUnavailable) {
    // Deliberately not gated on global.isAndroid: this runs in app workers
    // too, and a worker that had not yet imported the core globals would
    // silently drop every frame it renders.
    try {
      javaInstance = com.faceclaw.app.FrameTimings.getInstance();
    } catch {
      javaUnavailable = true;
    }
  }
  return javaInstance;
}

/** Begin a frame; parentFrameId links it under the frame that caused it. */
export function startFrame(reason: string, parentFrameId = 0): number {
  const java = getJava();
  if (!java) return fallbackNextFrameId--;
  // Guarded: requestRender-style callbacks can be invoked with an unrelated
  // argument, and a NaN would blow up the int marshalling.
  const parent = Number.isFinite(parentFrameId) ? Math.max(0, Math.round(parentFrameId)) : 0;
  return Number(java.startFrame(reason, parent));
}

/**
 * Append a fact to the frame's label, e.g. which app was in the foreground
 * when the input arrived. Shows in the frame's header line in the export.
 */
export function annotateFrame(frameId: number, text: string): void {
  if (frameId <= 0 || !text) return;
  getJava()?.annotate(frameId, text);
}

export function logFrame(frameId: number, message: string): void {
  if (frameId <= 0) return;
  getJava()?.log(frameId, message);
}

export function spanStart(frameId: number, name: string): void {
  if (frameId <= 0) return;
  getJava()?.spanStart(frameId, name);
}

export function spanEnd(frameId: number, name: string): void {
  if (frameId <= 0) return;
  getJava()?.spanEnd(frameId, name);
}

export function finishFrame(frameId: number, outcome: string): void {
  if (frameId <= 0) return;
  getJava()?.finishFrame(frameId, outcome);
}

export function span<T>(frameId: number, name: string, fn: () => T): T {
  spanStart(frameId, name);
  try {
    return fn();
  } finally {
    spanEnd(frameId, name);
  }
}

/**
 * Span around an awaited step. Most multi-second gaps in the timing export are
 * awaits (an app's async input handler, a worker round trip, the Java call
 * queue), so instrument those with this rather than leaving a bare jump.
 */
export async function spanAsync<T>(frameId: number, name: string, fn: () => Promise<T>): Promise<T> {
  spanStart(frameId, name);
  try {
    return await fn();
  } finally {
    spanEnd(frameId, name);
  }
}

/** Set the current frame while running fn, for leaf code using the *Current helpers. */
export function runWithFrame<T>(frameId: number, fn: () => T): T {
  const previous = currentFrameId;
  currentFrameId = frameId;
  try {
    return fn();
  } finally {
    currentFrameId = previous;
  }
}

export function currentFrame(): number {
  return currentFrameId;
}

export function logCurrent(message: string): void {
  logFrame(currentFrameId, message);
}

export function spanCurrent<T>(name: string, fn: () => T): T {
  return span(currentFrameId, name, fn);
}
