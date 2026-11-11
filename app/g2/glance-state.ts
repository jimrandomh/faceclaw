/**
 * The Glanceboard's visibility rules, as a pure reducer so they can be tested
 * without the display plumbing. The board is an alternate sleep-time display:
 * while the shell is asleep a press (single tap) shows it for a short while, a
 * head-tilt wake shows it until the head comes back down, a hold (long-press or
 * short-then-long-press) shows it until release, and a double-tap dismisses it
 * in favour of the regular UI. GlanceHost feeds
 * these events in and applies the resulting visibility to the compositor.
 *
 * No NativeScript imports: this module is compiled and run under plain node
 * by tests/glance-state.test.cjs.
 */

/** Fallback press timeout when the host supplies none; each further press restarts it. */
export const GLANCE_TIMEOUT_MS = 3000;

/**
 * Default cap for a head-tilt showing: the board normally stays up until the
 * head comes back down (as the stock dashboard does), but a lost head-down
 * event should not leave it on indefinitely. The user's Head tilt timeout
 * setting replaces it (and may remove it).
 */
export const GLANCE_TILT_MAX_MS = 60_000;

/**
 * The firmware reports head-down once the pitch falls 20° below the head-up
 * trigger (a fixed hysteresis in DRV_IMUCheckHeadUpEvent). Under this trigger,
 * looking level again does not get below that, so the head-down may never come.
 */
export const GLANCE_LOW_TILT_TRIGGER_DEGREES = 25;

/**
 * How long a head-tilt showing may last without a head-down: capMs (the Head
 * tilt timeout; null = no limit), except when the head-down is unlikely to
 * arrive, where the tap duration is used if shorter: a tilt that woke a
 * suspended EvenHub session (the head-down is only forwarded once the page is
 * back, so a quick glance can end before that), or a trigger too low for a
 * level gaze to count as looking down. triggerDegrees is the glasses'
 * trigger, or null when not known.
 */
export function glanceTiltMaxMs(options: {
  capMs: number | null;
  resumedSession: boolean;
  triggerDegrees: number | null;
  tapTimeoutMs: number;
}): number | null {
  const lowTrigger =
    options.triggerDegrees !== null && options.triggerDegrees > 0 && options.triggerDegrees < GLANCE_LOW_TILT_TRIGGER_DEGREES;
  if (!options.resumedSession && !lowTrigger) return options.capMs;
  return options.capMs === null ? options.tapTimeoutMs : Math.min(options.capMs, options.tapTimeoutMs);
}

export type GlanceState = {
  visible: boolean;
  /** A long-press is holding the board up; the timer does not run meanwhile. */
  holding: boolean;
  /**
   * A head-tilt is holding the board up: it stays until the firmware reports
   * the head back down (or tiltMaxMs passes).
   */
  tilted: boolean;
  /** The current head-tilt's cap (0 when not tilted, null for none); a hold ending mid-tilt re-arms it. */
  tiltMaxMs: number | null;
  /** When the board hides on its own (epoch ms), or null while held / hidden. */
  hideAtMs: number | null;
};

export type GlanceEvent =
  /** Single tap: show, and (re)start the auto-hide timer. */
  | { type: "press" }
  /**
   * Head-tilt (IMU head-up): show until the head comes back down, or until
   * maxMs passes (default GLANCE_TILT_MAX_MS; null = no limit).
   */
  | { type: "tilt"; maxMs?: number | null }
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

export const GLANCE_HIDDEN: GlanceState = Object.freeze({ visible: false, holding: false, tilted: false, tiltMaxMs: 0, hideAtMs: null });

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
      return { visible: true, holding: false, tilted: false, tiltMaxMs: 0, hideAtMs: nowMs + timeoutMs };
    case "tilt": {
      const maxMs = event.maxMs === undefined ? GLANCE_TILT_MAX_MS : event.maxMs;
      return { visible: true, holding: state.holding, tilted: true, tiltMaxMs: maxMs, hideAtMs: state.holding ? null : tiltHideAt(nowMs, maxMs) };
    }
    case "head-down":
      // Only a head-tilt showing ends with the head; a tap's timer or a hold keeps running.
      if (!state.tilted) return state;
      return state.holding ? { ...state, tilted: false, tiltMaxMs: 0 } : GLANCE_HIDDEN;
    case "hold":
      return { visible: true, holding: true, tilted: state.tilted, tiltMaxMs: state.tiltMaxMs, hideAtMs: null };
    case "release":
      // Releases delivered late or after a disabled hold gesture mean nothing here.
      if (!state.holding) return state;
      // Head still up: the board stays, as if the tilt had just shown it.
      return state.tilted
        ? { visible: true, holding: false, tilted: true, tiltMaxMs: state.tiltMaxMs, hideAtMs: tiltHideAt(nowMs, state.tiltMaxMs) }
        : GLANCE_HIDDEN;
    case "timeout":
      if (!state.visible || state.holding || state.hideAtMs === null || nowMs < state.hideAtMs) return state;
      return GLANCE_HIDDEN;
    case "dismiss":
      return GLANCE_HIDDEN;
  }
}

function tiltHideAt(nowMs: number, maxMs: number | null): number | null {
  return maxMs === null ? null : nowMs + maxMs;
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
