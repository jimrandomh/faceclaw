/**
 * The Glanceboard's visibility rules, as a pure reducer so they can be tested
 * without the display plumbing. The board is an alternate sleep-time display:
 * while the shell is asleep a press (single tap, or a head-tilt wake) shows it
 * for a short while, a hold (long-press or short-then-long-press) shows it until release,
 * and a double-tap dismisses it in favour of the regular UI. GlanceHost feeds
 * these events in and applies the resulting visibility to the compositor.
 *
 * No NativeScript imports: this module is compiled and run under plain node
 * by tests/glance-state.test.cjs.
 */

/** Fallback press timeout when the host supplies none; each further press restarts it. */
export const GLANCE_TIMEOUT_MS = 3000;

/**
 * Safety cap for a head-tilt showing: the board normally stays up until the
 * head comes back down (as the stock dashboard does), but a lost head-down
 * event must not leave it on forever.
 */
export const GLANCE_TILT_MAX_MS = 60_000;

export type GlanceState = {
  visible: boolean;
  /** A long-press is holding the board up; the timer does not run meanwhile. */
  holding: boolean;
  /**
   * A head-tilt is holding the board up: it stays until the firmware reports
   * the head back down (or GLANCE_TILT_MAX_MS passes).
   */
  tilted: boolean;
  /** When the board hides on its own (epoch ms), or null while held / hidden. */
  hideAtMs: number | null;
};

export type GlanceEvent =
  /** Single tap: show, and (re)start the auto-hide timer. */
  | { type: "press" }
  /** Head-tilt (IMU head-up): show until the head comes back down. */
  | { type: "tilt" }
  /** The IMU reported the head back down: ends a head-tilt showing. */
  | { type: "head-down" }
  /** Long-press: show and keep showing until the release. */
  | { type: "hold" }
  /** The long-press ended. */
  | { type: "release" }
  /** The auto-hide timer fired. */
  | { type: "timeout" }
  /** Double-tap (or any other wake of the regular UI): hide now. */
  | { type: "dismiss" };

export const GLANCE_HIDDEN: GlanceState = Object.freeze({ visible: false, holding: false, tilted: false, hideAtMs: null });

export function reduceGlance(
  state: GlanceState,
  event: GlanceEvent,
  nowMs: number,
  timeoutMs: number = GLANCE_TIMEOUT_MS,
): GlanceState {
  switch (event.type) {
    case "press":
      // A tap during a hold or a head-tilt changes nothing: those decide when it ends.
      if (state.holding || state.tilted) return state;
      return { visible: true, holding: false, tilted: false, hideAtMs: nowMs + timeoutMs };
    case "tilt":
      return { visible: true, holding: state.holding, tilted: true, hideAtMs: state.holding ? null : nowMs + GLANCE_TILT_MAX_MS };
    case "head-down":
      // Only a head-tilt showing ends with the head; a tap's timer or a hold keeps running.
      if (!state.tilted) return state;
      return state.holding ? { ...state, tilted: false } : GLANCE_HIDDEN;
    case "hold":
      return { visible: true, holding: true, tilted: state.tilted, hideAtMs: null };
    case "release":
      // Releases delivered late or after a disabled hold gesture mean nothing here.
      if (!state.holding) return state;
      // Head still up: the board stays, as if the tilt had just shown it.
      return state.tilted ? { visible: true, holding: false, tilted: true, hideAtMs: nowMs + GLANCE_TILT_MAX_MS } : GLANCE_HIDDEN;
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
  gesture: "click" | "double-click" | "long-press" | "short-then-long-press" | "long-press-release" | "head-tilt" | "head-down" | (string & {}),
  boardVisible: boolean,
): GlanceEvent | null {
  switch (gesture) {
    case "click":
      return { type: "press" };
    case "head-tilt":
      return { type: "tilt" };
    case "head-down":
      return boardVisible ? { type: "head-down" } : null;
    case "long-press":
    case "short-then-long-press":
      return { type: "hold" };
    case "long-press-release":
      return { type: "release" };
    case "double-click":
      return boardVisible ? { type: "dismiss" } : null;
    default:
      return null;
  }
}
