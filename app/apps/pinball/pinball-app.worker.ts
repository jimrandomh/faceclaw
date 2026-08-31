/**
 * Pinball app worker. One singleton window holds the whole game: a full-height
 * table on the left (plunger lane, rollover lanes, pop bumpers, slingshots,
 * flippers, center drain) and a score panel on the right.
 *
 * The BLE pipeline runs ~250 ms input-to-pixels and a handful of fps, so the
 * game is tuned latency-tolerant: gentle gravity and capped ball speeds (the
 * ball takes ~1.5 s to fall the table), an auto-cycle flip with a generous
 * hold window so an early click still connects, and a motion-ghost trail so
 * the ball reads at low frame rates. Physics runs at a 120 Hz fixed step
 * inside a ~9 fps render tick; the fingerprint dedup plus incremental frames
 * keep the BLE payload down to the dirty region around the ball.
 *
 * Controls (ball ready): scroll sets launch power, click launches. In play:
 * click flips both flippers, scroll-up/down flips left/right individually,
 * long-press nudges the table (three quick nudges tilt), double-click pauses.
 * Watch swipes: left/right work the matching flipper, up nudges (or raises
 * launch power at the plunger), down lowers launch power.
 * Paused/game over: click resumes or starts a new game, double-click yields
 * focus, long-press opens the window menu.
 */
import "@nativescript/core/globals";
import { GrayImage } from "../../graphics/image";
import { flattenPlanesWithDraws, planesFingerprint, singlePlane, type Plane } from "../../graphics/plane";
import { prepareFrameDraws } from "../../graphics/glyph-wire";
import { getFont } from "../../graphics/bdffont";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import * as frameTimings from "../../native/frame-timings";
import { getActiveDisplay } from "../../native/active-display";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { buildSoundSequencePayload, type Step } from "../../ui/sound-effects";
import { defaultWindowMenuItems, WindowMenu } from "../../ui/window-menu";
import type { WorkerAppMessage, WorkerAppReply } from "../../ui/shell/worker-window";
import {
  directionalFallback,
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_LONG_PRESS,
  GESTURE_SCROLL,
  type InputEvent,
} from "../../ui/gestures";
import { clamp } from "../../util/numeric-util";

declare const global: any;
declare const com: any;

const largeFont = getFont("terminus32");
const mediumFont = getFont("terminus24");
const smallFont = getDefaultSmallFont();

const HIGH_SCORE_KEY = "pinball.highScore";

// --- Table geometry (viewport coordinates, y down) -------------------------
// Playfield box; the plunger lane is the strip right of LANE_X inside it.
const LEFT = 10;
const RIGHT = 260;
const TOP = 4;
const BOTTOM = 256;
const LANE_X = 232;
const PANEL_X = 310;

const BALL_R = 6;
/** Ball resting spot on the plunger, and where launches start. */
const PLUNGER_X = (LANE_X + RIGHT) / 2;
const PLUNGER_Y = 240;

// --- Physics tuning (pixels, seconds) --------------------------------------
/** Gentle on purpose: a full-table drop takes ~1.5 s, which keeps the game
 * playable through the ~300 ms glasses round trip. */
const GRAVITY = 240;
const DRAG_PER_S = 0.12;
const MAX_SPEED = 600;
const PHYSICS_DT = 1 / 120;
const RENDER_TICK_MS = 110;
/** Launch speed by power setting (index = power - 1). */
const LAUNCH_SPEEDS = [320, 380, 440, 500, 560] as const;
const BUMPER_KICK = 340;
const SLING_KICK = 300;
const NUDGE_KICK_UP = 70;
const NUDGE_KICK_SIDE = 45;
/** Nudges add 1 heat each and decay slowly; reaching 3 tilts the ball away. */
const TILT_LIMIT = 3;
const TILT_HEAT_DECAY_PER_S = 0.4;

const SCORE_BUMPER = 100;
const SCORE_SLING = 25;
const SCORE_ROLLOVER = 50;
const SCORE_ALL_ROLLOVERS = 500;
const BALLS_PER_GAME = 3;

// --- Flippers ---------------------------------------------------------------
const FLIPPER_LEN = 37;
const FLIPPER_R = 5;
const FLIPPER_REST_DEG = 32;
const FLIPPER_UP_DEG = -34;
const FLIPPER_RISE_DEG_PER_S = 950;
const FLIPPER_FALL_DEG_PER_S = 480;
/** Held at the top this long before falling, so early flips still connect. */
const FLIPPER_HOLD_MS = 140;
const FLIPPER_E = 0.4;

type SegmentKind = "wall" | "gate" | "sling";

type Segment = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Restitution: how bouncy the surface is. */
  e: number;
  kind: SegmentKind;
  shade: number;
};

function seg(x0: number, y0: number, x1: number, y1: number, e: number, shade = 150, kind: SegmentKind = "wall"): Segment {
  return { x0, y0, x1, y1, e, kind, shade };
}

/** Chain of wall segments through the given points. */
function chain(points: Array<[number, number]>, e: number, shade = 150): Segment[] {
  const segments: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    segments.push(seg(points[i - 1]![0], points[i - 1]![1], points[i]![0], points[i]![1], e, shade));
  }
  return segments;
}

const SEGMENTS: Segment[] = [
  // Outer shell: left wall up into the top-left arc, across the top, down the
  // top-right arc to where the plunger-lane gate meets the right wall.
  ...chain([[LEFT, BOTTOM], [LEFT, 54], [16, 24], [34, 8], [58, TOP]], 0.45, 160),
  seg(58, TOP, 210, TOP, 0.45, 160),
  ...chain([[210, TOP], [236, 10], [254, 26], [RIGHT, 56]], 0.35, 160),
  // Plunger lane: right wall, floor, and the inner wall dividing it from the
  // playfield. The gate covers the lane and only collides from above, so a
  // launched ball passes up through it, and a ball that falls short lands on
  // it and rolls left off the inner-wall top into the playfield.
  seg(RIGHT, 56, RIGHT, BOTTOM, 0.3, 160),
  seg(LANE_X, BOTTOM, RIGHT, BOTTOM, 0.3, 160),
  // The gate line passes collinearly through the inner-wall top and overhangs
  // a few px into the playfield, so a short-launched ball rolls along it,
  // over the wall, off the end, and drops down the playfield side (a gate
  // ending at the wall top leaves a wedge pocket against the wall's end cap).
  seg(LANE_X, 66, LANE_X, BOTTOM, 0.3, 140),
  seg(RIGHT, 56, 226, 68, 0.2, 90, "gate"),
  // Rollover-lane divider posts across the top.
  seg(103, 20, 103, 46, 0.35, 130),
  seg(139, 20, 139, 46, 0.35, 130),
  // Inlane guides funneling everything above the flippers into them. Their
  // lines parallel the flipper rest angle, run tangent to the flipper's base
  // cap (shifted FLIPPER_R along the ball-side normal), and extend a little
  // past the pivot so the ball rolls straight onto the flipper surface.
  // Ending at the pivot center instead leaves a pocket against the base cap
  // that the flipper sweep can't eject (found in headless simulation).
  seg(LEFT, 184, 83, 230.5, 0.35, 150),
  seg(LANE_X, 184, 159, 230.5, 0.35, 150),
  // Slingshots above the guides: kicker face toward the table center,
  // passive back/bottom (the ball rides the guide underneath into the
  // flipper, inlane-style).
  seg(58, 166, 84, 204, 0.4, 170, "sling"),
  seg(58, 166, 58, 196, 0.4, 130),
  seg(58, 196, 84, 204, 0.4, 130),
  seg(184, 166, 158, 204, 0.4, 170, "sling"),
  seg(184, 166, 184, 196, 0.4, 130),
  seg(158, 204, 184, 196, 0.4, 130),
];

const BUMPERS = [
  { x: 75, y: 78, r: 13 },
  { x: 167, y: 78, r: 13 },
  { x: 121, y: 128, r: 13 },
] as const;

/** Rollover sensors sit in the three lanes between the top posts. */
const ROLLOVERS = [
  { x: 85, y: 34 },
  { x: 121, y: 34 },
  { x: 157, y: 34 },
] as const;
const ROLLOVER_TRIGGER_R = 10;

const FLIPPER_PIVOTS = [
  { x: 76, y: 232, mirror: 1 },
  { x: 166, y: 232, mirror: -1 },
] as const;

// --- Sounds -----------------------------------------------------------------
/** Buzzer effects (shared piezo, tuned soft). Minor hits are rate-limited so
 * a ball rattling in the bumpers can't flood the BLE link. */
const SFX_LAUNCH: Step[] = [
  { freq: 440, duty: 40, ms: 30 },
  { freq: 660, duty: 40, ms: 30 },
  { freq: 880, duty: 40, ms: 50 },
];
const SFX_FLIPPER: Step[] = [{ freq: 180, duty: 50, ms: 15 }];
const SFX_BUMPER: Step[] = [{ freq: 1568, duty: 40, ms: 20 }];
const SFX_SLING: Step[] = [{ freq: 1047, duty: 40, ms: 15 }];
const SFX_ROLLOVER: Step[] = [{ freq: 1319, duty: 40, ms: 25 }];
const SFX_BONUS: Step[] = [
  { freq: 1047, ms: 50 },
  { freq: 1319, ms: 50 },
  { freq: 1568, ms: 50 },
  { freq: 2093, ms: 120 },
];
const SFX_DRAIN: Step[] = [
  { freq: 494, duty: 45, ms: 100 },
  { freq: 370, duty: 45, ms: 100 },
  { freq: 247, duty: 50, ms: 200 },
];
const SFX_TILT: Step[] = [{ freq: 110, duty: 60, ms: 300 }];
const SFX_GAME_OVER: Step[] = [
  { freq: 494, duty: 45, ms: 150 },
  { freq: 440, duty: 45, ms: 150 },
  { freq: 392, duty: 45, ms: 150 },
  { freq: 349, duty: 45, ms: 380 },
];
const SFX_PAUSE: Step[] = [
  { freq: 1319, duty: 40, ms: 60 },
  { freq: 880, duty: 40, ms: 110 },
];
/** Also the new-game and sound-toggled-on confirmation. */
const SFX_RESUME: Step[] = [
  { freq: 880, duty: 40, ms: 60 },
  { freq: 1319, duty: 40, ms: 110 },
];
const MINOR_SFX_MIN_GAP_MS = 130;

type GamePhase = "playing" | "paused" | "game-over";

type FlipperState = "rest" | "rising" | "hold" | "falling";

type Flipper = {
  pivotX: number;
  pivotY: number;
  /** 1 = left flipper (points right-down at rest), -1 = mirrored right. */
  mirror: 1 | -1;
  angleDeg: number;
  state: FlipperState;
  holdUntilMs: number;
};

type PinballWindow = {
  windowId: string;
  surfaceId: string;
  viewportWidth: number;
  viewportHeight: number;
  foreground: boolean;
  /** Whether this window is the shell's input target (pushed with each message). */
  focused: boolean;
  /** Long-press window menu; created on first open. */
  menu: WindowMenu | null;
  phase: GamePhase;
  /** "ready" = parked on the plunger awaiting launch; "live" = in play. */
  ballState: "ready" | "live";
  ballX: number;
  ballY: number;
  ballVx: number;
  ballVy: number;
  /** Recent positions (one per physics step) for the motion-ghost trail. */
  trail: Array<[number, number]>;
  flippers: Flipper[];
  launchPower: number;
  ballsLeft: number;
  score: number;
  highScore: number;
  rolloverLit: boolean[];
  /** Debounce: a sensor re-arms only after the ball leaves its zone. */
  rolloverInside: boolean[];
  bumperFlashUntilMs: number[];
  tiltHeat: number;
  tilted: boolean;
  /** Alternates nudge direction so mashing doesn't push one way forever. */
  nudgeSign: 1 | -1;
  /** Transient center-table message ("BALL LOST", "+500", ...). */
  toast: string;
  toastUntilMs: number;
  tickTimer: ReturnType<typeof setInterval> | null;
  lastTickAtMs: number;
  lastMinorSfxAtMs: number;
  soundOn: boolean;
  lastSubmittedFingerprint: string;
};

const windows = new Map<string, PinballWindow>();
let screenOn = true;

function post(message: WorkerAppReply): void {
  global.postMessage(message);
}

// The host queues messages until this arrives: posts to a worker whose bundle
// is still evaluating can be silently dropped (see WorkerAppHost). Top-level
// evaluation is synchronous, so the handler below is installed before any
// queued message can be delivered.
post({ type: "worker-ready" });

global.onmessage = (event: { data: WorkerAppMessage }) => {
  const message = event.data;
  switch (message.type) {
    case "open-window": {
      const window: PinballWindow = {
        windowId: message.windowId,
        surfaceId: message.surfaceId,
        viewportWidth: message.viewport.width,
        viewportHeight: message.viewport.height,
        foreground: false,
        focused: false,
        menu: null,
        phase: "playing",
        ballState: "ready",
        ballX: PLUNGER_X,
        ballY: PLUNGER_Y,
        ballVx: 0,
        ballVy: 0,
        trail: [],
        flippers: FLIPPER_PIVOTS.map((pivot) => ({
          pivotX: pivot.x,
          pivotY: pivot.y,
          mirror: pivot.mirror,
          angleDeg: FLIPPER_REST_DEG,
          state: "rest",
          holdUntilMs: 0,
        })),
        launchPower: 4,
        ballsLeft: BALLS_PER_GAME,
        score: 0,
        highScore: loadHighScore(),
        rolloverLit: ROLLOVERS.map(() => false),
        rolloverInside: ROLLOVERS.map(() => false),
        bumperFlashUntilMs: BUMPERS.map(() => 0),
        tiltHeat: 0,
        tilted: false,
        nudgeSign: 1,
        toast: "",
        toastUntilMs: 0,
        tickTimer: null,
        lastTickAtMs: 0,
        lastMinorSfxAtMs: 0,
        soundOn: true,
        lastSubmittedFingerprint: "",
      };
      windows.set(message.windowId, window);
      break;
    }
    case "close-window": {
      const window = windows.get(message.windowId);
      if (window?.tickTimer) clearInterval(window.tickTimer);
      windows.delete(message.windowId);
      break;
    }
    case "input": {
      const window = windows.get(message.windowId);
      if (!window) {
        frameTimings.finishFrame(message.frameId, "discarded: unknown pinball window");
        break;
      }
      window.focused = message.focused;
      inferForeground(window, message.focused);
      // Marks the main-thread -> worker hop, which is otherwise an
      // unexplained gap inside the shell's handle-input span.
      frameTimings.logFrame(message.frameId, `input received in ${message.windowId} worker`);
      handleInput(window, message.event as InputEvent, message.frameId);
      break;
    }
    case "render": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.focused = message.focused;
      inferForeground(window, message.focused);
      renderAndSubmit(window, 0);
      break;
    }
    case "foreground": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.foreground = message.foreground;
      window.focused = message.focused;
      // The player can't see the ball while backgrounded, so don't let it
      // keep rolling.
      if (!window.foreground && window.phase === "playing") window.phase = "paused";
      syncTickTimer(window);
      if (window.foreground) renderAndSubmit(window, 0);
      break;
    }
    case "screen":
      screenOn = message.on;
      for (const window of windows.values()) {
        if (!screenOn && window.phase === "playing") window.phase = "paused";
        syncTickTimer(window);
      }
      break;
  }
};

/**
 * Input and render messages only ever target the shell's foreground window,
 * so a focused message proves this window is foreground. This backstops the
 * "foreground" message itself, which can be lost while a freshly spawned
 * worker is still evaluating its bundle (see the Blocks worker).
 */
function inferForeground(window: PinballWindow, focused: boolean): void {
  if (!focused || window.foreground) return;
  window.foreground = true;
  syncTickTimer(window);
}

function loadHighScore(): number {
  try {
    const parsed = parseInt(getStringSetting(HIGH_SCORE_KEY, "0"), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function saveHighScore(window: PinballWindow): void {
  if (window.score <= window.highScore) return;
  window.highScore = window.score;
  try {
    setStringSetting(HIGH_SCORE_KEY, String(window.highScore));
  } catch (error) {
    console.warn(`pinball high-score save failed: ${error}`);
  }
}

/**
 * Fire a buzzer effect. Non-blocking: the firmware's sequencer plays the
 * steps on its own timer, and the Java call is safe from the worker thread.
 * Minor (frequent) effects are dropped when they'd arrive within the
 * rate-limit gap; newsworthy ones always play.
 */
function playSfx(window: PinballWindow, steps: Step[], minor = false): void {
  if (!window.soundOn || steps.length === 0) return;
  const now = Date.now();
  if (minor && now - window.lastMinorSfxAtMs < MINOR_SFX_MIN_GAP_MS) return;
  if (minor) window.lastMinorSfxAtMs = now;
  try {
    const communicator = com.faceclaw.app.FaceclawBleCommunicator.getActive();
    if (!communicator) return;
    communicator.playBuzzerSequence(buildSoundSequencePayload(steps).buffer);
  } catch (error) {
    console.warn(`pinball sfx failed: ${error}`);
  }
}

/** The window's long-press menu (game actions + default entries). */
function openWindowMenu(window: PinballWindow): void {
  windowMenu(window).open([
    {
      label: "New game",
      onSelect: (ctx) => {
        ctx.stack.pop();
        resetGame(window);
        playSfx(window, SFX_RESUME);
      },
    },
    {
      label: window.soundOn ? "Sound: on" : "Sound: off",
      onSelect: (ctx) => {
        ctx.stack.pop();
        window.soundOn = !window.soundOn;
        if (window.soundOn) playSfx(window, SFX_RESUME);
      },
    },
    ...defaultWindowMenuItems(window.windowId, post),
  ]);
}

function windowMenu(window: PinballWindow): WindowMenu {
  if (!window.menu) {
    window.menu = new WindowMenu({
      size: { width: window.viewportWidth, height: window.viewportHeight },
      paintBase: () => paintContent(window),
      isFocused: () => window.focused,
    });
  }
  return window.menu;
}

function handleInput(window: PinballWindow, event: InputEvent, frameId: number): void {
  // An open window menu owns all input (it closes itself via pop); menus are
  // list UIs, so watch swipes take their standard fallback meanings there.
  if (window.menu?.isOpen()) {
    window.menu
      .handleInput(directionalFallback(event))
      .catch((error) => console.error(`pinball menu input failed: ${error}`))
      .then(() => renderAndSubmit(window, frameId));
    return;
  }

  if (window.phase === "playing") {
    handlePlayingInput(window, event, frameId);
  } else {
    handleIdleInput(window, event, frameId);
  }
}

function handlePlayingInput(window: PinballWindow, event: InputEvent, frameId: number): void {
  const ready = window.ballState === "ready";
  switch (event.type) {
    case "scroll-up":
      if (ready) {
        window.launchPower = clamp(window.launchPower + 1, 1, LAUNCH_SPEEDS.length);
      } else {
        flip(window, window.flippers[0]!);
      }
      break;
    case "scroll-down":
      if (ready) {
        window.launchPower = clamp(window.launchPower - 1, 1, LAUNCH_SPEEDS.length);
      } else {
        flip(window, window.flippers[1]!);
      }
      break;
    // Watch swipes: left/right work the matching flipper; up nudges the
    // table (or raises launch power at the plunger), down lowers it.
    case "swipe-left":
      if (!ready) flip(window, window.flippers[0]!);
      break;
    case "swipe-right":
      if (!ready) flip(window, window.flippers[1]!);
      break;
    case "swipe-up":
      if (ready) {
        window.launchPower = clamp(window.launchPower + 1, 1, LAUNCH_SPEEDS.length);
      } else {
        nudge(window);
      }
      break;
    case "swipe-down":
      if (ready) {
        window.launchPower = clamp(window.launchPower - 1, 1, LAUNCH_SPEEDS.length);
      }
      break;
    case "click":
      if (ready) {
        launchBall(window);
      } else {
        flip(window, window.flippers[0]!);
        flip(window, window.flippers[1]!);
      }
      break;
    case "long-press":
      if (ready) {
        frameTimings.finishFrame(frameId, "discarded: pinball ignored input");
        return;
      }
      nudge(window);
      break;
    case "double-click":
      window.phase = "paused";
      syncTickTimer(window);
      playSfx(window, SFX_PAUSE);
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: pinball ignored input");
      return;
  }
  syncTickTimer(window);
  renderAndSubmit(window, frameId);
}

/** Input while paused or game over. Swipes take their standard fallback meanings. */
function handleIdleInput(window: PinballWindow, event: InputEvent, frameId: number): void {
  switch (directionalFallback(event).type) {
    case "click":
      if (window.phase === "game-over") resetGame(window);
      window.phase = "playing";
      syncTickTimer(window);
      playSfx(window, SFX_RESUME);
      break;
    case "double-click":
      frameTimings.finishFrame(frameId, "discarded: pinball yielded focus");
      post({ type: "yield-focus", windowId: window.windowId });
      return;
    case "long-press":
      openWindowMenu(window);
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: pinball ignored input");
      return;
  }
  renderAndSubmit(window, frameId);
}

function resetGame(window: PinballWindow): void {
  window.phase = "playing";
  window.ballState = "ready";
  window.ballX = PLUNGER_X;
  window.ballY = PLUNGER_Y;
  window.ballVx = 0;
  window.ballVy = 0;
  window.trail = [];
  window.ballsLeft = BALLS_PER_GAME;
  window.score = 0;
  window.rolloverLit = ROLLOVERS.map(() => false);
  window.rolloverInside = ROLLOVERS.map(() => false);
  window.tiltHeat = 0;
  window.tilted = false;
  window.toast = "";
  window.toastUntilMs = 0;
  for (const flipper of window.flippers) {
    flipper.angleDeg = FLIPPER_REST_DEG;
    flipper.state = "rest";
  }
  syncTickTimer(window);
}

function launchBall(window: PinballWindow): void {
  window.ballState = "live";
  window.ballX = PLUNGER_X;
  window.ballY = PLUNGER_Y - 2;
  window.ballVx = 0;
  window.ballVy = -LAUNCH_SPEEDS[window.launchPower - 1]!;
  window.trail = [];
  playSfx(window, SFX_LAUNCH);
}

function flip(window: PinballWindow, flipper: Flipper): void {
  if (window.tilted) return;
  if (flipper.state === "hold") {
    flipper.holdUntilMs = Date.now() + FLIPPER_HOLD_MS;
    return;
  }
  flipper.state = "rising";
  playSfx(window, SFX_FLIPPER, true);
}

function nudge(window: PinballWindow): void {
  if (window.tilted) return;
  window.ballVy -= NUDGE_KICK_UP;
  window.ballVx += window.nudgeSign * NUDGE_KICK_SIDE;
  window.nudgeSign = window.nudgeSign === 1 ? -1 : 1;
  window.tiltHeat += 1;
  if (window.tiltHeat >= TILT_LIMIT) {
    window.tilted = true;
    showToast(window, "TILT");
    // A tilt drops the flippers dead until the ball drains.
    for (const flipper of window.flippers) {
      if (flipper.state !== "rest") flipper.state = "falling";
    }
    playSfx(window, SFX_TILT);
  }
}

function addScore(window: PinballWindow, points: number): void {
  if (!window.tilted) window.score += points;
}

function showToast(window: PinballWindow, text: string, ms = 1100): void {
  window.toast = text;
  window.toastUntilMs = Date.now() + ms;
}

// --- Simulation -------------------------------------------------------------

/** Anything moving or fading on screen? Drives whether the tick timer runs. */
function isAnimating(window: PinballWindow): boolean {
  if (window.ballState === "live") return true;
  if (window.flippers.some((flipper) => flipper.state !== "rest")) return true;
  const now = Date.now();
  if (window.toastUntilMs > now) return true;
  return window.bumperFlashUntilMs.some((until) => until > now);
}

/** Keep the render tick running exactly while something is visibly moving. */
function syncTickTimer(window: PinballWindow): void {
  const shouldRun =
    window.phase === "playing" && window.foreground && screenOn && isAnimating(window);
  if (!shouldRun && window.tickTimer !== null) {
    clearInterval(window.tickTimer);
    window.tickTimer = null;
  }
  if (shouldRun && window.tickTimer === null) {
    window.lastTickAtMs = Date.now();
    window.tickTimer = setInterval(() => tick(window), RENDER_TICK_MS);
  }
}

/** One render tick: catch the fixed-step physics up to real time, repaint. */
function tick(window: PinballWindow): void {
  if (window.phase !== "playing") {
    syncTickTimer(window);
    return;
  }
  const now = Date.now();
  const elapsedMs = Math.min(now - window.lastTickAtMs, 300);
  window.lastTickAtMs = now;
  const steps = clamp(Math.round(elapsedMs / (PHYSICS_DT * 1000)), 1, 40);
  for (let i = 0; i < steps; i++) {
    stepPhysics(window);
    if (window.ballState !== "live" && window.phase !== "playing") break;
  }
  renderAndSubmit(window, 0);
  // Stop ticking once everything has settled (ball parked, flippers down).
  syncTickTimer(window);
}

function stepPhysics(window: PinballWindow): void {
  const dt = PHYSICS_DT;
  stepFlippers(window, dt);
  window.tiltHeat = Math.max(0, window.tiltHeat - TILT_HEAT_DECAY_PER_S * dt);
  if (window.ballState !== "live") return;

  window.ballVy += GRAVITY * dt;
  const drag = Math.max(0, 1 - DRAG_PER_S * dt);
  window.ballVx *= drag;
  window.ballVy *= drag;
  const speed = Math.hypot(window.ballVx, window.ballVy);
  if (speed > MAX_SPEED) {
    window.ballVx *= MAX_SPEED / speed;
    window.ballVy *= MAX_SPEED / speed;
  }
  window.ballX += window.ballVx * dt;
  window.ballY += window.ballVy * dt;

  // Two resolution passes settle corner contacts (wall meets guide, etc.).
  for (let pass = 0; pass < 2; pass++) {
    for (const segment of SEGMENTS) collideSegment(window, segment);
    for (const flipper of window.flippers) collideFlipper(window, flipper);
    collideBumpers(window);
  }
  checkRollovers(window);

  window.trail.push([window.ballX, window.ballY]);
  if (window.trail.length > 10) window.trail.shift();

  // Drain: through the flipper gap (or anywhere physics went sideways).
  if (
    window.ballY > BOTTOM + 2 * BALL_R ||
    window.ballY < TOP - 40 ||
    window.ballX < LEFT - 40 ||
    window.ballX > RIGHT + 40
  ) {
    ballDrained(window);
  }
}

function stepFlippers(window: PinballWindow, dt: number): void {
  const now = Date.now();
  for (const flipper of window.flippers) {
    switch (flipper.state) {
      case "rising":
        flipper.angleDeg -= FLIPPER_RISE_DEG_PER_S * dt;
        if (flipper.angleDeg <= FLIPPER_UP_DEG) {
          flipper.angleDeg = FLIPPER_UP_DEG;
          flipper.state = "hold";
          flipper.holdUntilMs = now + FLIPPER_HOLD_MS;
        }
        break;
      case "hold":
        if (now >= flipper.holdUntilMs) flipper.state = "falling";
        break;
      case "falling":
        flipper.angleDeg += FLIPPER_FALL_DEG_PER_S * dt;
        if (flipper.angleDeg >= FLIPPER_REST_DEG) {
          flipper.angleDeg = FLIPPER_REST_DEG;
          flipper.state = "rest";
        }
        break;
    }
  }
}

/** Angular velocity in rad/s implied by the flipper's animation state. */
function flipperOmega(flipper: Flipper): number {
  if (flipper.state === "rising") return (-FLIPPER_RISE_DEG_PER_S * Math.PI) / 180;
  if (flipper.state === "falling") return (FLIPPER_FALL_DEG_PER_S * Math.PI) / 180;
  return 0;
}

function collideSegment(window: PinballWindow, segment: Segment): void {
  const dx = segment.x1 - segment.x0;
  const dy = segment.y1 - segment.y0;
  const lengthSq = dx * dx + dy * dy;
  const t = clamp(
    ((window.ballX - segment.x0) * dx + (window.ballY - segment.y0) * dy) / lengthSq,
    0,
    1,
  );
  const closestX = segment.x0 + t * dx;
  const closestY = segment.y0 + t * dy;
  const offX = window.ballX - closestX;
  const offY = window.ballY - closestY;
  const dist = Math.hypot(offX, offY);
  if (dist >= BALL_R || dist === 0) return;
  const nx = offX / dist;
  const ny = offY / dist;
  // The one-way gate only exists for a ball above it (launches pass through).
  if (segment.kind === "gate" && ny > -0.3) return;
  window.ballX += nx * (BALL_R - dist);
  window.ballY += ny * (BALL_R - dist);
  const vn = window.ballVx * nx + window.ballVy * ny;
  if (vn >= 0) return;
  if (segment.kind === "sling") {
    // Kicker face: fires the ball off at a fixed speed along the normal.
    window.ballVx = window.ballVx - vn * nx + nx * SLING_KICK;
    window.ballVy = window.ballVy - vn * ny + ny * SLING_KICK;
    addScore(window, SCORE_SLING);
    playSfx(window, SFX_SLING, true);
    return;
  }
  window.ballVx -= (1 + segment.e) * vn * nx;
  window.ballVy -= (1 + segment.e) * vn * ny;
}

function collideFlipper(window: PinballWindow, flipper: Flipper): void {
  const angle = (flipper.angleDeg * Math.PI) / 180;
  const dirX = flipper.mirror * Math.cos(angle);
  const dirY = Math.sin(angle);
  const relX = window.ballX - flipper.pivotX;
  const relY = window.ballY - flipper.pivotY;
  const t = clamp(relX * dirX + relY * dirY, 0, FLIPPER_LEN);
  const closestX = flipper.pivotX + t * dirX;
  const closestY = flipper.pivotY + t * dirY;
  const offX = window.ballX - closestX;
  const offY = window.ballY - closestY;
  const dist = Math.hypot(offX, offY);
  const reach = BALL_R + FLIPPER_R;
  if (dist >= reach || dist === 0) return;
  const nx = offX / dist;
  const ny = offY / dist;
  window.ballX += nx * (reach - dist);
  window.ballY += ny * (reach - dist);
  // Reflect relative to the moving surface: the rotation is what imparts the
  // kick when the flipper is rising under the ball.
  const omega = flipperOmega(flipper);
  const surfaceVx = -t * omega * flipper.mirror * dirY;
  const surfaceVy = t * omega * flipper.mirror * dirX;
  const relVn = (window.ballVx - surfaceVx) * nx + (window.ballVy - surfaceVy) * ny;
  if (relVn >= 0) return;
  window.ballVx -= (1 + FLIPPER_E) * relVn * nx;
  window.ballVy -= (1 + FLIPPER_E) * relVn * ny;
}

function collideBumpers(window: PinballWindow): void {
  for (let i = 0; i < BUMPERS.length; i++) {
    const bumper = BUMPERS[i]!;
    const offX = window.ballX - bumper.x;
    const offY = window.ballY - bumper.y;
    const dist = Math.hypot(offX, offY);
    const reach = BALL_R + bumper.r;
    if (dist >= reach || dist === 0) continue;
    const nx = offX / dist;
    const ny = offY / dist;
    window.ballX += nx * (reach - dist);
    window.ballY += ny * (reach - dist);
    // Pop bumper: fires the ball away at a fixed speed regardless of impact.
    const tangential = window.ballVx * -ny + window.ballVy * nx;
    window.ballVx = nx * BUMPER_KICK + -ny * tangential * 0.3;
    window.ballVy = ny * BUMPER_KICK + nx * tangential * 0.3;
    window.bumperFlashUntilMs[i] = Date.now() + 180;
    addScore(window, SCORE_BUMPER);
    playSfx(window, SFX_BUMPER, true);
  }
}

function checkRollovers(window: PinballWindow): void {
  for (let i = 0; i < ROLLOVERS.length; i++) {
    const sensor = ROLLOVERS[i]!;
    const inside =
      Math.hypot(window.ballX - sensor.x, window.ballY - sensor.y) < ROLLOVER_TRIGGER_R;
    if (inside && !window.rolloverInside[i] && !window.rolloverLit[i]) {
      window.rolloverLit[i] = true;
      addScore(window, SCORE_ROLLOVER);
      if (window.rolloverLit.every(Boolean)) {
        addScore(window, SCORE_ALL_ROLLOVERS);
        window.rolloverLit = ROLLOVERS.map(() => false);
        showToast(window, `+${SCORE_ALL_ROLLOVERS}`);
        playSfx(window, SFX_BONUS);
      } else {
        playSfx(window, SFX_ROLLOVER, true);
      }
    }
    window.rolloverInside[i] = inside;
  }
}

function ballDrained(window: PinballWindow): void {
  window.ballState = "ready";
  window.ballX = PLUNGER_X;
  window.ballY = PLUNGER_Y;
  window.ballVx = 0;
  window.ballVy = 0;
  window.trail = [];
  window.tilted = false;
  window.tiltHeat = 0;
  window.ballsLeft--;
  if (window.ballsLeft <= 0) {
    window.phase = "game-over";
    saveHighScore(window);
    playSfx(window, SFX_GAME_OVER);
  } else {
    showToast(window, "BALL LOST");
    playSfx(window, SFX_DRAIN);
  }
  syncTickTimer(window);
}

// --- Painting ---------------------------------------------------------------

let staticBackground: GrayImage | null = null;

/** Everything that never changes: walls, guides, slings, outlines, labels. */
function getStaticBackground(window: PinballWindow): GrayImage {
  if (staticBackground) return staticBackground;
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  for (const segment of SEGMENTS) {
    image.drawLine(segment.x0, segment.y0, segment.x1, segment.y1, segment.shade);
  }
  for (const bumper of BUMPERS) {
    drawCircleOutline(image, bumper.x, bumper.y, bumper.r, 130);
  }
  image.drawText(smallFont, PANEL_X, 12, "Score", 140);
  image.drawText(smallFont, PANEL_X, 84, "Ball", 140);
  image.drawText(smallFont, PANEL_X, 148, "High", 140);
  staticBackground = image;
  return image;
}

function fillCircle(image: GrayImage, cx: number, cy: number, r: number, shade: number): void {
  for (let dy = -r; dy <= r; dy++) {
    const half = Math.floor(Math.sqrt(r * r - dy * dy));
    image.fillRect(Math.round(cx) - half, Math.round(cy) + dy, half * 2 + 1, 1, shade);
  }
}

function drawCircleOutline(image: GrayImage, cx: number, cy: number, r: number, shade: number): void {
  const samples = Math.max(24, Math.ceil(r * 8));
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * 2 * Math.PI;
    image.setPixel(Math.round(cx + r * Math.cos(angle)), Math.round(cy + r * Math.sin(angle)), shade);
  }
}

function drawFlipper(image: GrayImage, flipper: Flipper): void {
  const angle = (flipper.angleDeg * Math.PI) / 180;
  const dirX = flipper.mirror * Math.cos(angle);
  const dirY = Math.sin(angle);
  // Capsule: stamped circles along the segment, thicker at the pivot.
  for (let t = 0; t <= FLIPPER_LEN; t += 2) {
    const r = t < 8 ? FLIPPER_R : FLIPPER_R - 1;
    fillCircle(image, flipper.pivotX + t * dirX, flipper.pivotY + t * dirY, r, 255);
  }
}

function paint(window: PinballWindow): Plane[] {
  if (window.menu?.isOpen()) {
    return window.menu.paint();
  }
  return singlePlane(paintContent(window));
}

function paintContent(window: PinballWindow): GrayImage {
  const image = getStaticBackground(window).clone();
  const now = Date.now();

  // Bumper caps: bright while flashing from a hit.
  for (let i = 0; i < BUMPERS.length; i++) {
    const bumper = BUMPERS[i]!;
    if (window.bumperFlashUntilMs[i]! > now) {
      fillCircle(image, bumper.x, bumper.y, bumper.r - 2, 230);
    } else {
      fillCircle(image, bumper.x, bumper.y, 4, 170);
    }
  }
  // Rollover lights.
  for (let i = 0; i < ROLLOVERS.length; i++) {
    const sensor = ROLLOVERS[i]!;
    if (window.rolloverLit[i]) {
      fillCircle(image, sensor.x, sensor.y, 5, 220);
    } else {
      drawCircleOutline(image, sensor.x, sensor.y, 5, 110);
    }
  }
  for (const flipper of window.flippers) drawFlipper(image, flipper);

  // Ball with motion ghosts a few physics steps back, so its path reads at
  // the low frame rate the BLE link can deliver.
  if (window.ballState === "live") {
    const ghostA = window.trail[window.trail.length - 5];
    const ghostB = window.trail[window.trail.length - 9];
    if (ghostB) fillCircle(image, ghostB[0], ghostB[1], BALL_R - 2, 60);
    if (ghostA) fillCircle(image, ghostA[0], ghostA[1], BALL_R - 1, 110);
  }
  fillCircle(image, window.ballX, window.ballY, BALL_R, 255);

  // Plunger power meter in the lane above the parked ball.
  if (window.ballState === "ready" && window.phase === "playing") {
    for (let i = 0; i < LAUNCH_SPEEDS.length; i++) {
      const y = PLUNGER_Y - 22 - i * 5;
      const shade = i < window.launchPower ? 230 : 70;
      image.fillRect(Math.round(PLUNGER_X) - 8, y, 16, 3, shade);
    }
  }

  paintPanel(image, window);

  if (window.toastUntilMs > now && window.toast) {
    drawCenteredIn(image, mediumFont, LEFT, LANE_X - LEFT, 150, window.toast, 245);
  }
  if (window.tilted) {
    drawCenteredIn(image, mediumFont, LEFT, LANE_X - LEFT, 60, "TILT", 245);
  }
  if (window.phase === "paused") {
    paintDialog(image, "PAUSED", [`${GESTURE_CLICK} resume`, `${GESTURE_DOUBLE_CLICK} leave`]);
  } else if (window.phase === "game-over") {
    paintDialog(image, "GAME OVER", [
      `score ${window.score}`,
      `${GESTURE_CLICK} new game`,
    ]);
  }
  return image;
}

function paintDialog(image: GrayImage, title: string, lines: string[]): void {
  const width = 150;
  const height = 46 + lines.length * 20;
  const x = LEFT + Math.round((LANE_X - LEFT - width) / 2);
  const y = 80;
  image.fillRect(x, y, width, height, 0);
  image.drawRect(x + 3, y + 3, width - 6, height - 6, 150);
  drawCenteredIn(image, mediumFont, x, width, y + 12, title, 245);
  lines.forEach((line, i) => {
    drawCenteredIn(image, smallFont, x, width, y + 40 + i * 20, line, 150);
  });
}

function paintPanel(image: GrayImage, window: PinballWindow): void {
  image.drawText(largeFont, PANEL_X, 30, String(window.score), 235);
  image.drawText(largeFont, PANEL_X, 102, `${window.ballsLeft}/${BALLS_PER_GAME}`, 235);
  image.drawText(
    largeFont,
    PANEL_X,
    166,
    String(Math.max(window.highScore, window.score)),
    235,
  );

  if (window.phase === "playing" && window.ballState === "ready") {
    image.drawText(smallFont, PANEL_X, 216, `${GESTURE_SCROLL} power   ${GESTURE_CLICK} launch`, 115);
    image.drawText(smallFont, PANEL_X, 236, `${GESTURE_DOUBLE_CLICK} pause`, 115);
  } else {
    image.drawText(smallFont, PANEL_X, 216, `${GESTURE_CLICK} flip   ${GESTURE_SCROLL} L/R flip`, 115);
    image.drawText(smallFont, PANEL_X, 236, `${GESTURE_LONG_PRESS} nudge   ${GESTURE_DOUBLE_CLICK} pause`, 115);
  }
}

function drawCenteredIn(
  image: GrayImage,
  font: typeof smallFont,
  x: number,
  width: number,
  y: number,
  text: string,
  value: number,
): void {
  image.drawText(font, Math.round(x + (width - font.measureText(text)) / 2), y, text, value);
}

function renderAndSubmit(window: PinballWindow, inputFrameId: number): void {
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${window.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => paint(window)),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = planesFingerprint(planes);
    if (fingerprint === window.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: pinball content unchanged");
      return;
    }
    const communicator = getActiveDisplay();
    if (!communicator) {
      frameTimings.finishFrame(frameId, "discarded: no active display");
      return;
    }
    const { image, draws } = frameTimings.span(frameId, "flatten", () => flattenPlanesWithDraws(planes));
    const buffer = frameTimings.span(frameId, "to8bpp", () => image.to8bppBuffer());
    communicator.submitSurfaceFrame(
      buffer.buffer,
      window.surfaceId,
      0,
      0,
      image.width,
      image.height,
      fingerprint,
      paintMs,
      frameId,
      frameTimings.span(frameId, "prepareFrameDraws", () => prepareFrameDraws(draws)),
    );
    window.lastSubmittedFingerprint = fingerprint;
  } catch (error) {
    frameTimings.finishFrame(frameId, "discarded: pinball render failed");
    console.error(`pinball worker render failed: ${error}`);
  }
}
