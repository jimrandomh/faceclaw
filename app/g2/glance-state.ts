/**
 * The Glanceboard's visibility rules, as a pure reducer so they can be tested
 * without the display plumbing. The board is an alternate sleep-time display:
 * while the shell is asleep a press (single tap, or a head-tilt wake) shows it
 * for a short while, a hold (long-press) shows it until the press is released,
 * and a double-tap dismisses it in favour of the regular UI. GlanceHost feeds
 * these events in and applies the resulting visibility to the compositor.
 *
 * No NativeScript imports: this module is compiled and run under plain node
 * by tests/glance-state.test.cjs.
 */

/** Fallback press timeout when the host supplies none; each further press restarts it. */
export const GLANCE_TIMEOUT_MS = 3000;

export type GlanceState = {
  visible: boolean;
  /** A long-press is holding the board up; the timer does not run meanwhile. */
  holding: boolean;
  /** When the board hides on its own (epoch ms), or null while held / hidden. */
  hideAtMs: number | null;
};

export type GlanceEvent =
  /** Single tap or head-tilt wake: show, and (re)start the auto-hide timer. */
  | { type: "press" }
  /** Long-press: show and keep showing until the release. */
  | { type: "hold" }
  /** The long-press ended. */
  | { type: "release" }
  /** The auto-hide timer fired. */
  | { type: "timeout" }
  /** Double-tap (or any other wake of the regular UI): hide now. */
  | { type: "dismiss" };

export const GLANCE_HIDDEN: GlanceState = Object.freeze({ visible: false, holding: false, hideAtMs: null });

export function reduceGlance(
  state: GlanceState,
  event: GlanceEvent,
  nowMs: number,
  timeoutMs: number = GLANCE_TIMEOUT_MS,
): GlanceState {
  switch (event.type) {
    case "press":
      // A tap during a hold changes nothing: the hold decides when it ends.
      if (state.holding) return state;
      return { visible: true, holding: false, hideAtMs: nowMs + timeoutMs };
    case "hold":
      return { visible: true, holding: true, hideAtMs: null };
    case "release":
      // Releases also follow presses the board was never holding for (a
      // tap-then-hold, a release delivered late); those mean nothing here.
      return state.holding ? GLANCE_HIDDEN : state;
    case "timeout":
      if (!state.visible || state.holding || state.hideAtMs === null || nowMs < state.hideAtMs) return state;
      return GLANCE_HIDDEN;
    case "dismiss":
      return GLANCE_HIDDEN;
  }
}

/**
 * Which glance event, if any, a shell input gesture means while the screen is
 * off. A double-tap only concerns the board while it is showing (it then
 * dismisses it before waking the regular UI); everything else the shell
 * already handles or ignores while asleep.
 */
export function glanceEventForGesture(
  gesture: "click" | "double-click" | "long-press" | "long-press-release" | "head-tilt" | string,
  boardVisible: boolean,
): GlanceEvent | null {
  switch (gesture) {
    case "click":
    case "head-tilt":
      return { type: "press" };
    case "long-press":
      return { type: "hold" };
    case "long-press-release":
      return { type: "release" };
    case "double-click":
      return boardVisible ? { type: "dismiss" } : null;
    default:
      return null;
  }
}
