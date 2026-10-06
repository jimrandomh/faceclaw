/**
 * New-notification modals, one at a time. Each modal is a near-64 KiB
 * on-glasses surface, and stacking one per posted notification overflowed the
 * glasses' resource cache (#42). Notifications that arrive while a modal is
 * open wait here and open in turn as each one closes.
 *
 * `M` is the host's modal handle; the host creates and stacks modals, and
 * reports back how each one left the stack.
 */
export interface NotificationModalHost<M> {
  /** Create and stack a modal showing this notification. */
  open(notificationKey: string): M;
  /** Whether a queued notification is still worth opening (not dismissed, popups still on). */
  isAvailable(notificationKey: string): boolean;
  /** Put the screen back to sleep. */
  sleep(): void;
}

interface Entry {
  readonly notificationKey: string;
  /** Whether this notification woke the screen, so closing the last modal sleeps again. */
  readonly wokeScreen: boolean;
}

export class NotificationModalQueue<M> {
  private current: (Entry & { readonly modal: M }) | null = null;
  private readonly queued: Entry[] = [];

  constructor(private readonly host: NotificationModalHost<M>) {}

  /**
   * A notification was posted. Opens it now, or queues it behind the open
   * modal. A repost of the open notification needs nothing: its modal repaints
   * from the live notification.
   */
  post(notificationKey: string, wokeScreen: boolean): void {
    if (this.current) {
      if (this.current.notificationKey !== notificationKey
          && !this.queued.some((entry) => entry.notificationKey === notificationKey)) {
        this.queued.push({ notificationKey, wokeScreen });
      }
      return;
    }
    this.current = { modal: this.host.open(notificationKey), notificationKey, wokeScreen };
  }

  /**
   * The user closed `modal`. Opens the next queued notification; once none
   * are left, goes back to sleep if any of them woke the screen. Call before
   * unstacking the modal, so the removal it reports is already accounted for.
   */
  closed(modal: M): void {
    const current = this.current;
    if (current?.modal !== modal) return;
    this.current = null;
    if (!this.openNext(current.wokeScreen) && current.wokeScreen) {
      this.host.sleep();
    }
  }

  /**
   * `modal` left the stack some other way. Going to sleep clears popups (the
   * notifications stay in the Notifications app), so a screen that is off
   * drops the queue; otherwise the next notification opens.
   */
  removed(modal: M, screenOn: boolean): void {
    const current = this.current;
    if (current?.modal !== modal) return;
    this.current = null;
    if (!screenOn) {
      this.queued.length = 0;
      return;
    }
    this.openNext(current.wokeScreen);
  }

  /** Notifications waiting behind the open modal (for diagnostics and tests). */
  queuedKeys(): string[] {
    return this.queued.map((entry) => entry.notificationKey);
  }

  private openNext(wokeScreen: boolean): boolean {
    while (this.queued.length > 0) {
      const next = this.queued.shift()!;
      if (!this.host.isAvailable(next.notificationKey)) continue;
      this.post(next.notificationKey, wokeScreen || next.wokeScreen);
      return true;
    }
    return false;
  }
}
