/**
 * Holds each newly posted notification back briefly before it pops up on the
 * glasses, so one that its source withdraws right away never shows (nor wakes
 * the screen). Google Messages, for one, posts a "Messages is working in the
 * background" foreground-service notification whenever it handles an incoming
 * message or a background sync, then cancels it a second or two later, after
 * posting the message's own notification under a different key (if any).
 */

/** Delay for ordinary notifications: enough to skip one withdrawn or replaced as soon as it is posted. */
export const NOTIFICATION_POPUP_DELAY_MS = 500;
/**
 * Delay for foreground-service notifications. They are "app is working"
 * status, often gone within seconds; Android itself defers showing them for
 * 10s for the same reason. Messages' lasts up to ~2s (Pixel usage-stats timings).
 */
export const FOREGROUND_SERVICE_POPUP_DELAY_MS = 5000;

/** Categories that must pop up promptly even from a foreground service (an incoming call, a ringing alarm). */
const URGENT_CATEGORIES = new Set(["call", "alarm"]);

export function notificationPopupDelayMs(notification: { foregroundService?: boolean; category: string }): number {
  return notification.foregroundService && !URGENT_CATEGORIES.has(notification.category)
    ? FOREGROUND_SERVICE_POPUP_DELAY_MS : NOTIFICATION_POPUP_DELAY_MS;
}

/** Runs `run` after `delayMs`; returns a function that cancels it. */
export type ScheduleFn = (run: () => void, delayMs: number) => () => void;

const scheduleTimeout: ScheduleFn = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

export class NotificationPopupDelay {
  private readonly pending = new Map<string, { dueAtMs: number; cancel: () => void }>();

  /** `ready` receives each notification that survived its delay, to re-check and pop up. */
  constructor(
    private readonly ready: (notificationKey: string) => void,
    private readonly schedule: ScheduleFn = scheduleTimeout,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A notification was posted, to pop up after `delayMs`. A repost while it
   * waits can only bring the popup forward: a notification its source keeps
   * updating is not held back indefinitely, and one rewritten from a
   * foreground-service placeholder into a real message (same key) gets the
   * shorter delay.
   */
  post(notificationKey: string, delayMs: number): void {
    const dueAtMs = this.now() + delayMs;
    const existing = this.pending.get(notificationKey);
    if (existing) {
      if (existing.dueAtMs <= dueAtMs) return;
      existing.cancel();
    }
    const cancel = this.schedule(() => {
      this.pending.delete(notificationKey);
      this.ready(notificationKey);
    }, delayMs);
    this.pending.set(notificationKey, { dueAtMs, cancel });
  }

  /** The notification went away before popping up; returns whether it was waiting. */
  withdraw(notificationKey: string): boolean {
    const existing = this.pending.get(notificationKey);
    if (!existing) return false;
    existing.cancel();
    this.pending.delete(notificationKey);
    return true;
  }

  /** Notifications waiting out their delay (for diagnostics and tests). */
  pendingKeys(): string[] {
    return Array.from(this.pending.keys());
  }
}
