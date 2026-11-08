import { scheduleTimeout, type ScheduleFn } from "./notification-popup-delay";

/**
 * Closes a new-notification popup that is left untouched for its timeout
 * ("Display new notifications"). The host restarts the countdown when the
 * popup opens and on each interaction with it (any input, including moving
 * its menu selection), and stops it when the popup goes away.
 */
export class NotificationPopupTimeout {
  private cancel: (() => void) | null = null;

  /** `timeoutMs` null never expires (the popup stays until dismissed). */
  constructor(
    private readonly timeoutMs: number | null,
    private readonly expired: () => void,
    private readonly schedule: ScheduleFn = scheduleTimeout,
  ) {}

  /** Start the countdown over. */
  restart(): void {
    this.stop();
    if (this.timeoutMs === null) return;
    this.cancel = this.schedule(() => {
      this.cancel = null;
      this.expired();
    }, this.timeoutMs);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  /** Whether a countdown is running (for tests). */
  isRunning(): boolean {
    return this.cancel !== null;
  }
}
