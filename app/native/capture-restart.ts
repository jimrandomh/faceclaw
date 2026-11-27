// A capture that ended by itself while someone still holds it is started again
// after these delays (the last one repeats).
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
// A capture that then ran this long had recovered: its next failure is a new one.
const RESTART_STABLE_MS = 30_000;

/**
 * How long to wait before starting a mic capture again after it ended by
 * itself: the glasses refused or dropped the mic, the recognizer gave up. The
 * wait grows while the capture keeps failing, so a cause that will not go away
 * (the glasses in their case, a rejected API key) costs a try every half
 * minute rather than a busy loop, and one that passes (the display path
 * coming up after a reconnect) is over in a second or two.
 */
export class CaptureRestartBackoff {
  private attempt = 0;
  private startedAtMs = 0;

  /** A capture was started at `nowMs`. */
  started(nowMs: number): void {
    this.startedAtMs = nowMs;
  }

  /** The capture ended by itself at `nowMs`: the wait before the next start, in ms. */
  nextDelay(nowMs: number): number {
    // Judged once per start: a retry that never got as far as starting must
    // not count the last capture's long run again.
    if (this.startedAtMs !== 0 && nowMs - this.startedAtMs >= RESTART_STABLE_MS) this.attempt = 0;
    this.startedAtMs = 0;
    const delay = RESTART_BACKOFF_MS[Math.min(this.attempt, RESTART_BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    return delay;
  }

  /** The next failure is a new one: the holder let go, or there is a new session to capture from. */
  reset(): void {
    this.attempt = 0;
  }
}
