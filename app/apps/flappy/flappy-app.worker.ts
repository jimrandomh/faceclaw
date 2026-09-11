/**
 * Flappy app worker: a Flappy Bird-style side scroller. One singleton
 * window; the bird sits a third of the way across, pipes scroll in from the
 * right, a flap counters gravity, and the score is one point per pipe pair
 * cleared.
 *
 * The BLE pipeline runs ~250 ms input-to-pixels and a handful of fps, so the
 * game is tuned latency-tolerant: slow scroll, gentle gravity, a wide gap,
 * and a forgiving hitbox. Physics runs at a 60 Hz fixed step inside a ~12 fps
 * render tick.
 *
 * Bandwidth: everything that moves is a sprite placed with drawImage, so the
 * wire pipeline can ship it as an on-glasses cached-image draw (a 9-byte
 * record) rather than pixels. The bird is pre-rendered at a few tilt angles
 * and wing positions; pipes are a cap plus vertically uniform body tiles;
 * the ground is one tile repeated. Sprites hanging off the top or left edge
 * fall back to raster (the planner needs a non-negative origin), which is
 * small and rare.
 *
 * Controls (watch swipe-up is the primary flap): swipe-up, click, or
 * scroll-up flaps; double-click pauses; tap-then-hold opens the window
 * menu. Ready / paused / game over: click or swipe-up starts or resumes,
 * double-click yields focus.
 */
import "@nativescript/core/globals";
import { GrayImage } from "../../graphics/image";
import { flattenPlanesWithDraws, planesFingerprint, type Plane } from "../../graphics/plane";
import { prepareFrameDraws } from "../../graphics/glyph-wire";
import { getFont } from "../../graphics/bdffont";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import * as frameTimings from "../../native/frame-timings";
import { getActiveDisplay } from "../../native/active-display";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { buildSoundSequencePayload, type Step } from "../../ui/sound-effects";
import { type MenuItem } from "../../ui/menu";
import { WindowMenu } from "../../ui/window-menu";
import type { WorkerAppMessage, WorkerAppReply } from "../../ui/shell/worker-window";
import {
  directionalFallback,
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  type InputEvent,
} from "../../ui/gestures";
import { clamp } from "../../util/numeric-util";
import {
  BIRD_ANGLES,
  BIRD_SPRITE_H,
  BIRD_SPRITE_W,
  BIRD_WING_FRAMES,
  createBirdSprite,
  createGroundTile,
  createPipeBodyTile,
  createPipeCap,
  GROUND_H,
  GROUND_TILE_W,
  PIPE_BODY_TILE_H,
  PIPE_CAP_H,
  PIPE_CAP_OVERHANG,
  PIPE_CAP_W,
  PIPE_W,
} from "./flappy-sprites";

declare const global: any;
declare const com: any;

const largeFont = getFont("terminus32");
const mediumFont = getFont("terminus24");
const smallFont = getDefaultSmallFont();

const HIGH_SCORE_KEY = "flappy.highScore";

// --- Tuning (pixels, seconds) ------------------------------------------------
/** Bird center x; fixed, the world scrolls past it. */
const BIRD_X = 150;
/** Gentle on purpose: a flap-to-flap cycle is well over the glasses round trip. */
const GRAVITY = 520;
const FLAP_VY = -215;
const MAX_FALL_SPEED = 330;
const SCROLL_SPEED = 76;
const GAP_H = 104;
const PIPE_SPACING = 236;
/** Least body height either pipe of a pair keeps, so gaps never hug an edge. */
const MIN_PIPE_BODY = 30;
/** Forgiving hitbox half-extents around the bird center. */
const HITBOX_HALF_W = 9;
const HITBOX_HALF_H = 7;
const PHYSICS_DT = 1 / 60;
const RENDER_TICK_MS = 30;
/** Physics steps per wing frame while flying. */
const WING_STEPS_PER_FRAME = 6;

const SFX_FLAP: Step[] = [{ freq: 880, duty: 40, ms: 20 }, { freq: 1175, duty: 40, ms: 25 }];
const SFX_SCORE: Step[] = [{ freq: 1568, duty: 40, ms: 40 }, { freq: 2093, duty: 40, ms: 60 }];
const SFX_HIT: Step[] = [{ freq: 220, duty: 55, ms: 80 }, { freq: 165, duty: 55, ms: 120 }];
const SFX_GAME_OVER: Step[] = [
  { freq: 494, duty: 45, ms: 150 },
  { freq: 440, duty: 45, ms: 150 },
  { freq: 392, duty: 45, ms: 150 },
  { freq: 294, duty: 50, ms: 320 },
];
const SFX_PAUSE: Step[] = [
  { freq: 1319, duty: 40, ms: 60 },
  { freq: 880, duty: 40, ms: 110 },
];
const SFX_RESUME: Step[] = [
  { freq: 880, duty: 40, ms: 60 },
  { freq: 1319, duty: 40, ms: 110 },
];
const MINOR_SFX_MIN_GAP_MS = 120;

/**
 * ready: bird hovering, waiting for the first flap. playing: scrolling.
 * dying: hit something, bird tumbling to the ground with the world frozen.
 * game-over / paused: static screens with a dialog.
 */
type GamePhase = "ready" | "playing" | "dying" | "game-over" | "paused";

type Pipe = {
  /** Body left edge in viewport coordinates. */
  x: number;
  /** Bottom of the top pipe's cap; the gap runs from here to gapTop + GAP_H. */
  gapTop: number;
  scored: boolean;
};

type FlappyWindow = {
  windowId: string;
  surfaceId: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  foreground: boolean;
  /** Whether this window is the shell's input target (pushed with each message). */
  focused: boolean;
  /** Tap-then-hold window menu; created on first open. */
  menu: WindowMenu | null;
  phase: GamePhase;
  birdY: number;
  birdVy: number;
  /** Physics steps since the game started; drives the wing animation. */
  stepCount: number;
  /** World scroll distance so far, for the ground tiling phase. */
  scrollX: number;
  pipes: Pipe[];
  score: number;
  highScore: number;
  tickTimer: ReturnType<typeof setInterval> | null;
  lastTickAtMs: number;
  lastMinorSfxAtMs: number;
  soundOn: boolean;
  lastSubmittedFingerprint: string;
};

const windows = new Map<string, FlappyWindow>();
let screenOn = true;

// --- Sprites (immutable, built once per worker) -----------------------------

const pipeBodyTile = createPipeBodyTile();
const pipeCap = createPipeCap();
const groundTile = createGroundTile();
/** [angleIndex][wingFrame] */
const birdSprites: GrayImage[][] = BIRD_ANGLES.map((angle) =>
  Array.from({ length: BIRD_WING_FRAMES }, (_, frame) => createBirdSprite(angle, frame)),
);

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
      const window: FlappyWindow = {
        windowId: message.windowId,
        surfaceId: message.surfaceId,
        title: message.title,
        viewportWidth: message.viewport.width,
        viewportHeight: message.viewport.height,
        foreground: false,
        focused: false,
        menu: null,
        phase: "ready",
        birdY: 0,
        birdVy: 0,
        stepCount: 0,
        scrollX: 0,
        pipes: [],
        score: 0,
        highScore: loadHighScore(),
        tickTimer: null,
        lastTickAtMs: 0,
        lastMinorSfxAtMs: 0,
        soundOn: true,
        lastSubmittedFingerprint: "",
      };
      resetGame(window);
      windows.set(message.windowId, window);
      break;
    }
    case "resize-window": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.viewportWidth = message.viewport.width;
      window.viewportHeight = message.viewport.height;
      window.menu?.resize({ width: window.viewportWidth, height: window.viewportHeight });
      if (window.foreground) renderAndSubmit(window, 0);
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
        frameTimings.finishFrame(message.frameId, "discarded: unknown flappy window");
        break;
      }
      window.focused = message.focused;
      inferForeground(window, message.focused);
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
      // The player can't see the bird while backgrounded, so don't let it
      // keep falling.
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
function inferForeground(window: FlappyWindow, focused: boolean): void {
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

function saveHighScore(window: FlappyWindow): void {
  if (window.score <= window.highScore) return;
  window.highScore = window.score;
  try {
    setStringSetting(HIGH_SCORE_KEY, String(window.highScore));
  } catch (error) {
    console.warn(`flappy high-score save failed: ${error}`);
  }
}

/**
 * Fire a buzzer effect. Non-blocking: the firmware's sequencer plays the
 * steps on its own timer, and the Java call is safe from the worker thread.
 * Minor (frequent) effects are dropped when they'd arrive within the
 * rate-limit gap; newsworthy ones always play.
 */
function playSfx(window: FlappyWindow, steps: Step[], minor = false): void {
  if (!window.soundOn || steps.length === 0) return;
  const now = Date.now();
  if (minor && now - window.lastMinorSfxAtMs < MINOR_SFX_MIN_GAP_MS) return;
  if (minor) window.lastMinorSfxAtMs = now;
  try {
    const communicator = com.faceclaw.app.FaceclawBleCommunicator.getActive();
    if (!communicator) return;
    communicator.playBuzzerSequence(buildSoundSequencePayload(steps).buffer);
  } catch (error) {
    console.warn(`flappy sfx failed: ${error}`);
  }
}

function windowMenuItems(window: FlappyWindow): MenuItem[] {
  return [
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
  ];
}

function windowMenu(window: FlappyWindow): WindowMenu {
  if (!window.menu) {
    window.menu = new WindowMenu({
      windowId: window.windowId,
      post,
      title: () => window.title,
      items: () => windowMenuItems(window),
      size: { width: window.viewportWidth, height: window.viewportHeight },
      paintBase: () => paintContent(window),
      isFocused: () => window.focused,
    });
  }
  return window.menu;
}

// --- Input ------------------------------------------------------------------

function handleInput(window: FlappyWindow, event: InputEvent, frameId: number): void {
  // An open window menu owns all input (it closes itself via pop); menus are
  // list UIs, so watch swipes take their standard fallback meanings there.
  if (window.menu?.isOpen()) {
    window.menu
      .handleInput(directionalFallback(event))
      .catch((error) => console.error(`flappy menu input failed: ${error}`))
      .then(() => renderAndSubmit(window, frameId));
    return;
  }

  // Opening the menu mid-flight would leave the bird falling under it.
  if (event.type === "short-then-long-press") {
    if (window.phase === "playing") {
      window.phase = "paused";
      syncTickTimer(window);
    }
    windowMenu(window).open();
    renderAndSubmit(window, frameId);
    return;
  }

  switch (window.phase) {
    case "ready":
    case "playing":
      handleFlightInput(window, event, frameId);
      break;
    case "dying":
      // Let the tumble finish; a flap mashed during it must not restart.
      frameTimings.finishFrame(frameId, "discarded: flappy ignored input while dying");
      break;
    default:
      handleIdleInput(window, event, frameId);
      break;
  }
}

/** Input while ready or flying: the flap gestures, plus pause. */
function handleFlightInput(window: FlappyWindow, event: InputEvent, frameId: number): void {
  switch (event.type) {
    case "swipe-up":
    case "click":
    case "scroll-up":
      flap(window);
      break;
    case "double-click":
      if (window.phase === "playing") {
        window.phase = "paused";
        playSfx(window, SFX_PAUSE);
      } else {
        frameTimings.finishFrame(frameId, "discarded: flappy yielded focus");
        post({ type: "yield-focus", windowId: window.windowId });
        return;
      }
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: flappy ignored input");
      return;
  }
  syncTickTimer(window);
  renderAndSubmit(window, frameId);
}

/** Input while paused or game over. Swipes take their standard fallback meanings. */
function handleIdleInput(window: FlappyWindow, event: InputEvent, frameId: number): void {
  switch (directionalFallback(event).type) {
    case "click":
      if (window.phase === "game-over") {
        resetGame(window);
      } else {
        window.phase = "playing";
      }
      syncTickTimer(window);
      playSfx(window, SFX_RESUME);
      break;
    case "double-click":
      frameTimings.finishFrame(frameId, "discarded: flappy yielded focus");
      post({ type: "yield-focus", windowId: window.windowId });
      return;
    default:
      frameTimings.finishFrame(frameId, "discarded: flappy ignored input");
      return;
  }
  renderAndSubmit(window, frameId);
}

function groundTop(window: FlappyWindow): number {
  return window.viewportHeight - GROUND_H;
}

function resetGame(window: FlappyWindow): void {
  window.phase = "ready";
  window.birdY = Math.round(groundTop(window) * 0.42);
  window.birdVy = 0;
  window.stepCount = 0;
  window.scrollX = 0;
  window.pipes = [];
  window.score = 0;
  syncTickTimer(window);
}

function flap(window: FlappyWindow): void {
  if (window.phase === "ready") {
    window.phase = "playing";
    window.lastTickAtMs = Date.now();
  }
  window.birdVy = FLAP_VY;
  playSfx(window, SFX_FLAP, true);
}

// --- Simulation -------------------------------------------------------------

function isAnimating(window: FlappyWindow): boolean {
  return window.phase === "playing" || window.phase === "dying";
}

/** Keep the render tick running exactly while something is visibly moving. */
function syncTickTimer(window: FlappyWindow): void {
  const shouldRun = window.foreground && screenOn && isAnimating(window);
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
function tick(window: FlappyWindow): void {
  if (!isAnimating(window)) {
    syncTickTimer(window);
    return;
  }
  const now = Date.now();
  const elapsedMs = Math.min(now - window.lastTickAtMs, 300);
  window.lastTickAtMs = now;
  const steps = clamp(Math.round(elapsedMs / (PHYSICS_DT * 1000)), 1, 20);
  for (let i = 0; i < steps && isAnimating(window); i++) {
    stepPhysics(window);
  }
  renderAndSubmit(window, 0);
  syncTickTimer(window);
}

function stepPhysics(window: FlappyWindow): void {
  const dt = PHYSICS_DT;
  window.stepCount++;
  window.birdVy = Math.min(window.birdVy + GRAVITY * dt, MAX_FALL_SPEED);
  window.birdY += window.birdVy * dt;
  const floor = groundTop(window) - HITBOX_HALF_H;

  if (window.phase === "dying") {
    if (window.birdY >= floor) {
      window.birdY = floor;
      finishGame(window);
    }
    return;
  }

  // Ceiling: stop rather than die, like the original.
  if (window.birdY < HITBOX_HALF_H) {
    window.birdY = HITBOX_HALF_H;
    window.birdVy = Math.max(0, window.birdVy);
  }

  const advance = SCROLL_SPEED * dt;
  window.scrollX += advance;
  for (const pipe of window.pipes) pipe.x -= advance;
  if (window.pipes.length && window.pipes[0]!.x + PIPE_W + PIPE_CAP_OVERHANG < 0) {
    window.pipes.shift();
  }
  const last = window.pipes[window.pipes.length - 1];
  if (!last || last.x <= window.viewportWidth - PIPE_SPACING) {
    spawnPipe(window, last ? last.x + PIPE_SPACING : window.viewportWidth + 40);
  }

  for (const pipe of window.pipes) {
    if (!pipe.scored && pipe.x + PIPE_W < BIRD_X - HITBOX_HALF_W) {
      pipe.scored = true;
      window.score++;
      playSfx(window, SFX_SCORE);
    }
  }

  if (window.birdY >= floor) {
    window.birdY = floor;
    playSfx(window, SFX_HIT);
    finishGame(window);
    return;
  }
  if (window.pipes.some((pipe) => hitsPipe(window, pipe))) {
    window.phase = "dying";
    window.birdVy = Math.max(window.birdVy, 40);
    playSfx(window, SFX_HIT);
  }
}

function spawnPipe(window: FlappyWindow, x: number): void {
  const minGapTop = PIPE_CAP_H + MIN_PIPE_BODY;
  const maxGapTop = groundTop(window) - GAP_H - PIPE_CAP_H - MIN_PIPE_BODY;
  const gapTop = Math.round(minGapTop + Math.random() * Math.max(0, maxGapTop - minGapTop));
  window.pipes.push({ x, gapTop, scored: false });
}

function hitsPipe(window: FlappyWindow, pipe: Pipe): boolean {
  const left = BIRD_X - HITBOX_HALF_W;
  const right = BIRD_X + HITBOX_HALF_W;
  const top = window.birdY - HITBOX_HALF_H;
  const bottom = window.birdY + HITBOX_HALF_H;
  const capLeft = pipe.x - PIPE_CAP_OVERHANG;
  const capRight = capLeft + PIPE_CAP_W;
  const gapBottom = pipe.gapTop + GAP_H;
  // The cap is wider than the body, so test the whole pipe at cap width for
  // the cap rows and at body width elsewhere.
  const withinBody = right > pipe.x && left < pipe.x + PIPE_W;
  const withinCap = right > capLeft && left < capRight;
  if (withinCap) {
    if (bottom > pipe.gapTop - PIPE_CAP_H && top < pipe.gapTop) return true;
    if (bottom > gapBottom && top < gapBottom + PIPE_CAP_H) return true;
  }
  if (withinBody) {
    if (top < pipe.gapTop - PIPE_CAP_H) return true;
    if (bottom > gapBottom + PIPE_CAP_H) return true;
  }
  return false;
}

function finishGame(window: FlappyWindow): void {
  window.phase = "game-over";
  saveHighScore(window);
  playSfx(window, SFX_GAME_OVER);
  syncTickTimer(window);
}

// --- Painting ---------------------------------------------------------------

/**
 * Place a sprite. A whole sprite with a non-negative origin goes through the
 * deferred-image path (texture cacheable); anything hanging off the top or
 * left edge, or vertically clipped, falls back to a raster blit, since
 * cached draws are whole-image only with an unsigned origin.
 */
function stamp(image: GrayImage, sprite: GrayImage, x: number, y: number, clipHeight?: number): void {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix >= 0 && iy >= 0 && (clipHeight === undefined || clipHeight >= sprite.height)) {
    image.drawImage(sprite, ix, iy);
  } else {
    image.bitBlt(sprite, ix, iy, { height: clipHeight, transparentZero: true });
  }
}

function paint(window: FlappyWindow): Plane[] {
  return windowMenu(window).paint();
}

function paintContent(window: FlappyWindow): GrayImage {
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  const ground = groundTop(window);

  for (const pipe of window.pipes) paintPipe(image, pipe, ground);

  // Ground: tiles phased by the scroll distance so the hatching moves.
  const groundPhase = -(Math.round(window.scrollX) % GROUND_TILE_W);
  for (let x = groundPhase; x < window.viewportWidth; x += GROUND_TILE_W) {
    stamp(image, groundTile, x, ground);
  }

  // Bird last, so it sits over the pipes when they meet.
  const sprite = birdSprites[birdAngleIndex(window)]![birdWingFrame(window)]!;
  stamp(image, sprite, BIRD_X - BIRD_SPRITE_W / 2, window.birdY - BIRD_SPRITE_H / 2);

  paintHud(image, window);
  return image;
}

function paintPipe(image: GrayImage, pipe: Pipe, ground: number): void {
  const capX = pipe.x - PIPE_CAP_OVERHANG;
  // Top pipe: cap just above the gap, body tiles stacked upward from it. The
  // tile that would start above the top edge is clipped to raster.
  const topBodyBottom = pipe.gapTop - PIPE_CAP_H;
  for (let y = topBodyBottom - PIPE_BODY_TILE_H; y > -PIPE_BODY_TILE_H; y -= PIPE_BODY_TILE_H) {
    stamp(image, pipeBodyTile, pipe.x, y);
  }
  stamp(image, pipeCap, capX, topBodyBottom);

  // Bottom pipe: cap just below the gap, body tiles stacked down to the
  // ground; the final partial tile is clipped to raster.
  const gapBottom = pipe.gapTop + GAP_H;
  stamp(image, pipeCap, capX, gapBottom);
  for (let y = gapBottom + PIPE_CAP_H; y < ground; y += PIPE_BODY_TILE_H) {
    stamp(image, pipeBodyTile, pipe.x, y, Math.min(PIPE_BODY_TILE_H, ground - y));
  }
}

/** Nose-up while rising, nose-down the faster the fall; steepest during the death tumble. */
function birdAngleIndex(window: FlappyWindow): number {
  if (window.phase === "ready") return 1;
  if (window.phase === "dying") return BIRD_ANGLES.length - 1;
  const target = window.birdVy < 0 ? -25 : (window.birdVy / MAX_FALL_SPEED) * 55;
  let best = 0;
  for (let i = 1; i < BIRD_ANGLES.length - 1; i++) {
    if (Math.abs(BIRD_ANGLES[i]! - target) < Math.abs(BIRD_ANGLES[best]! - target)) best = i;
  }
  return best;
}

function birdWingFrame(window: FlappyWindow): number {
  if (window.phase !== "playing") return 1;
  // Up, mid, down, mid, ... so the wing beats rather than snaps.
  const cycle = [0, 1, 2, 1];
  return cycle[Math.floor(window.stepCount / WING_STEPS_PER_FRAME) % cycle.length]!;
}

function paintHud(image: GrayImage, window: FlappyWindow): void {
  const width = window.viewportWidth;
  if (window.phase !== "ready") {
    drawCenteredIn(image, largeFont, 0, width, 10, String(window.score), 245);
  }
  switch (window.phase) {
    case "ready":
      drawCenteredIn(image, mediumFont, 0, width, 14, "FLAPPY", 245);
      if (window.highScore > 0) {
        drawCenteredIn(image, smallFont, 0, width, 44, `best ${window.highScore}`, 150);
      }
      drawCenteredIn(image, smallFont, 0, width, groundTop(window) - 26, `swipe up / ${GESTURE_CLICK} flap`, 150);
      break;
    case "paused":
      paintDialog(image, window, "PAUSED", [`${GESTURE_CLICK} resume`, `${GESTURE_DOUBLE_CLICK} leave`]);
      break;
    case "game-over":
      paintDialog(image, window, "GAME OVER", [
        `score ${window.score}   best ${window.highScore}`,
        `${GESTURE_CLICK} new game   ${GESTURE_DOUBLE_CLICK} leave`,
      ]);
      break;
  }
}

function paintDialog(image: GrayImage, window: FlappyWindow, title: string, lines: string[]): void {
  const width = 260;
  const height = 46 + lines.length * 20;
  const x = Math.round((window.viewportWidth - width) / 2);
  const y = Math.round((groundTop(window) - height) / 2);
  image.fillRect(x, y, width, height, 0);
  image.drawRect(x + 3, y + 3, width - 6, height - 6, 150);
  drawCenteredIn(image, mediumFont, x, width, y + 12, title, 245);
  lines.forEach((line, i) => {
    drawCenteredIn(image, smallFont, x, width, y + 40 + i * 20, line, 150);
  });
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

function renderAndSubmit(window: FlappyWindow, inputFrameId: number): void {
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${window.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => paint(window)),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = planesFingerprint(planes);
    if (fingerprint === window.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: flappy content unchanged");
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
    frameTimings.finishFrame(frameId, "discarded: flappy render failed");
    console.error(`flappy worker render failed: ${error}`);
  }
}
