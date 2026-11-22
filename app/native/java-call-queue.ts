/**
 * The most compositor calls in a row that may leave their composite to the
 * call queued behind them (see JavaCallQueue.enqueueCompositorCall). A burst
 * made in one go is a handful; the bound is there so that a caller which
 * always has another call queued still gets frames out.
 */
export const MAX_MERGED_COMPOSITES = 8;

/**
 * Orders the Android bridge's calls into Java (FaceclawCommunicatorBridge),
 * each in a task of its own so that a slow one yields to the main looper
 * first.
 */
export class JavaCallQueue {
  private tail: Promise<void> = Promise.resolve();
  /** Calls waiting on the queue; 0 means enqueue's fast path is safe. */
  private queued = 0;
  private queuedSurfaceChanges = 0;
  /** Compositor calls waiting on the queue. */
  private queuedComposites = 0;
  /** Compositor calls run since the last one that composited. */
  private merged = 0;

  /**
   * flushComposite submits the compositor's current state as a frame: the
   * fallback for merged calls when the call that was to composite for them
   * threw instead.
   */
  constructor(private readonly flushComposite: () => void) {}

  /** Whether a queued call may change what a surface holds. */
  get surfaceChangesQueued(): boolean {
    return this.queuedSurfaceChanges > 0;
  }

  /**
   * Run a Java call, ordered against every other call made through here.
   *
   * inlineWhenIdle runs the call on the spot when nothing is queued ahead of
   * it. Ordering still holds — the fast path only fires when no earlier call
   * is waiting — and it skips a task-queue hop that measured ~18ms on device
   * (the gap between "span submit start" and the Java side's own log line in
   * the frame timings), which is pure latency on a call the caller is already
   * awaiting. Off by default: a call that might block for a while should keep
   * yielding to the main looper first.
   *
   * preservesSurfaces marks a call that neither changes a surface's retained
   * content nor leaves a change waiting for a later composite (it composites
   * itself, or a compositor call queued behind it does), so having it queued
   * does not make surfaceChangesQueued true.
   */
  enqueue<T>(operation: () => T, inlineWhenIdle = false, preservesSurfaces = false): Promise<T> {
    if (inlineWhenIdle && this.queued === 0) {
      try {
        return Promise.resolve(operation());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    this.queued++;
    if (!preservesSurfaces) this.queuedSurfaceChanges++;
    const run = () =>
      new Promise<T>((resolve, reject) => {
        setTimeout(() => {
          this.queued--;
          if (!preservesSurfaces) this.queuedSurfaceChanges--;
          try {
            resolve(operation());
          } catch (error) {
            reject(error);
          }
        }, 0);
      });

    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Run a call that changes the compositor and submits the recomposited
   * screen to the glasses. The call is told to merge, leaving that submit
   * out, when another compositor call is already queued behind it: that one
   * composites for both. A window switch hides one surface, shows another,
   * and submits the new window's frame and the shell's without awaiting any
   * of them; unmerged, the glasses got the first of those as a frame of its
   * own (the old window blanked out) and the rest a full present later.
   */
  enqueueCompositorCall(operation: (merge: boolean) => void, inlineWhenIdle = false, preservesSurfaces = false): Promise<void> {
    this.queuedComposites++;
    return this.enqueue(() => {
      this.queuedComposites--;
      const owed = this.merged > 0;
      const merge = this.queuedComposites > 0 && this.merged < MAX_MERGED_COMPOSITES;
      this.merged = merge ? this.merged + 1 : 0;
      try {
        operation(merge);
      } catch (error) {
        if (owed && !merge) {
          try {
            this.flushComposite();
          } catch {
            // The call's own error is the one to report.
          }
        }
        throw error;
      }
    }, inlineWhenIdle, preservesSurfaces);
  }
}
