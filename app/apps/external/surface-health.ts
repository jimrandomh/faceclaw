/** First-frame deadline only. Static screens need no heartbeat. */
export class SurfaceHealth {
  private readonly states = new Map<string, {
    key: string;
    ready: boolean;
    failed: boolean;
    /** Visible, awake time already spent waiting for the first frame. */
    elapsedMs: number;
    visibleSince?: number;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  constructor(private readonly expired: (feature: string) => void, private readonly changed: () => void, private readonly deadlineMs = 2500) {}
  open(feature: string, key: string): boolean {
    const previous = this.states.get(feature);
    // A failed stream remains quarantined until its owner/epoch changes or the
    // caller explicitly retries it. A successful open is a new native stream,
    // even when the component and dimensions happen to be unchanged, so it
    // must wait for a new first frame before it can claim the screen/input.
    if (previous?.failed) return false;
    this.close(feature);
    this.states.set(feature, { key, ready: false, failed: false, elapsedMs: 0 });
    return true;
  }
  visible(feature: string, visible: boolean): void {
    const state = this.states.get(feature); if (!state) return;
    if (!visible) {
      this.pause(state);
      return;
    }
    if (state.ready || state.failed || state.timer !== undefined) return;
    state.visibleSince = Date.now();
    const remaining = Math.max(0, this.deadlineMs - state.elapsedMs);
    state.timer = setTimeout(() => {
      if (this.states.get(feature) !== state) return;
      this.pause(state);
      state.failed = true;
      this.expired(feature); this.changed();
    }, remaining);
  }
  frame(feature: string): boolean {
    const state = this.states.get(feature); if (!state || state.failed) return false;
    this.pause(state);
    clearTimeout(state.timer); state.timer = undefined;
    const first = !state.ready; state.ready = true;
    if (first) this.changed();
    return true;
  }
  active(feature: string): boolean { return this.states.get(feature)?.failed !== true && this.states.has(feature); }
  ready(feature: string): boolean { return this.states.get(feature)?.ready === true && !this.failed(feature); }
  failed(feature: string): boolean { return this.states.get(feature)?.failed === true; }
  close(feature: string, preserveFailure = false): void {
    const state = this.states.get(feature); if (!state) return;
    this.pause(state);
    if (!preserveFailure || !state.failed) this.states.delete(feature);
  }

  private pause(state: { elapsedMs: number; visibleSince?: number; timer?: ReturnType<typeof setTimeout> }): void {
    if (state.visibleSince !== undefined) {
      state.elapsedMs += Math.max(0, Date.now() - state.visibleSince);
      state.visibleSince = undefined;
    }
    clearTimeout(state.timer); state.timer = undefined;
  }
}
