/**
 * Blocks app worker: a falling-blocks game. One singleton window holds the
 * whole game; a gravity interval drives piece descent while the window is
 * foreground and the screen is on (losing either auto-pauses).
 *
 * Controls (in play): scroll moves the piece, click rotates, long-press hard
 * drops, double-click pauses. Watch swipes are spatial: left/right move,
 * up rotates, down hard-drops. Paused: click resumes, double-click yields
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

declare const global: any;
declare const com: any;

const largeFont = getFont("terminus32");
const mediumFont = getFont("terminus24");
const smallFont = getDefaultSmallFont();

const COLS = 10;
const ROWS = 20;
const CELL = 12;
const BOARD_X = 60;
const BOARD_Y = 10;
const PANEL_X = 230;

/** Gravity starts here and speeds up with score (see dropIntervalMs). */
const BASE_DROP_MS = 1200;
const MIN_DROP_MS = 200;
/** Every this many points, gravity gets one 12% step faster. */
const SPEED_STEP_SCORE = 300;
/** Points per cleared-line count (index = simultaneous lines), times level. */
const LINE_SCORES = [0, 100, 300, 500, 800];
const HARD_DROP_POINTS_PER_ROW = 2;
const LINES_PER_LEVEL = 10;

/**
 * The seven tetrominoes as cells in an N×N grid (spawn orientation), plus a
 * per-piece gray so they stay distinguishable after 4bpp quantization.
 */
const PIECE_DEFS: Array<{ size: number; cells: Array<[number, number]>; shade: number }> = [
  { size: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]], shade: 250 }, // I
  { size: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]], shade: 225 }, // O
  { size: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]], shade: 200 }, // T
  { size: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]], shade: 175 }, // S
  { size: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]], shade: 150 }, // Z
  { size: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]], shade: 125 }, // J
  { size: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]], shade: 100 }, // L
];

/** All four rotations of each piece, precomputed by grid rotation. */
const PIECE_ROTATIONS: Array<Array<Array<[number, number]>>> = PIECE_DEFS.map((def) => {
  const rotations: Array<Array<[number, number]>> = [def.cells];
  for (let r = 1; r < 4; r++) {
    rotations.push(
      rotations[r - 1]!.map(([x, y]) => [def.size - 1 - y, x] as [number, number]),
    );
  }
  return rotations;
});

/** Horizontal wall-kick offsets tried in order when a rotation collides. */
const KICK_OFFSETS = [0, -1, 1, -2, 2];

/**
 * Buzzer effects, each a single sequencer message (movement and rotation stay
 * silent: they're too frequent for the BLE budget and would grate anyway).
 * Frequencies are equal-tempered note pitches; duty tuned soft for the piezo.
 */
const SFX_LOCK: Step[] = [{ freq: 330, duty: 40, ms: 20 }];
const SFX_HARD_DROP: Step[] = [
  { freq: 1200, duty: 40, ms: 12 },
  { freq: 700, duty: 45, ms: 14 },
  { freq: 300, duty: 55, ms: 30 },
];
/** Rising arpeggio, one note per cleared line (index = line count). */
const SFX_LINE_CLEAR: Step[][] = [
  [],
  [{ freq: 1047, ms: 60 }, { freq: 1319, ms: 110 }],
  [{ freq: 1047, ms: 55 }, { freq: 1319, ms: 55 }, { freq: 1568, ms: 130 }],
  [{ freq: 1047, ms: 50 }, { freq: 1319, ms: 50 }, { freq: 1568, ms: 50 }, { freq: 2093, ms: 150 }],
  [
    { freq: 1568, ms: 45 },
    { freq: 2093, ms: 45 },
    { freq: 2637, ms: 45 },
    { freq: 3136, ms: 60 },
    { freq: 1, duty: 0, ms: 30 },
    { freq: 3136, ms: 140 },
  ],
];
const SFX_LEVEL_UP: Step[] = [
  { freq: 784, ms: 45 },
  { freq: 988, ms: 45 },
  { freq: 1175, ms: 45 },
  { freq: 1568, ms: 60 },
  { freq: 1, duty: 0, ms: 25 },
  { freq: 2093, ms: 160 },
];
const SFX_GAME_OVER: Step[] = [
  { freq: 494, duty: 45, ms: 150 },
  { freq: 466, duty: 45, ms: 150 },
  { freq: 440, duty: 45, ms: 150 },
  { freq: 415, duty: 45, ms: 150 },
  { freq: 392, duty: 45, ms: 380 },
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

type GamePhase = "playing" | "paused" | "game-over";

type BlocksWindow = {
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
  /** Locked cells; 0 = empty, otherwise the piece's shade byte. */
  board: Uint8Array;
  pieceIndex: number;
  pieceRotation: number;
  pieceX: number;
  pieceY: number;
  nextPieceIndex: number;
  /** 7-bag randomizer: refilled and shuffled when drained. */
  bag: number[];
  score: number;
  lines: number;
  tickTimer: ReturnType<typeof setInterval> | null;
  tickIntervalMs: number;
  soundOn: boolean;
  lastSubmittedFingerprint: string;
};

const windows = new Map<string, BlocksWindow>();
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
      const window: BlocksWindow = {
        windowId: message.windowId,
        surfaceId: message.surfaceId,
        viewportWidth: message.viewport.width,
        viewportHeight: message.viewport.height,
        foreground: false,
        focused: false,
        menu: null,
        phase: "playing",
        board: new Uint8Array(COLS * ROWS),
        pieceIndex: 0,
        pieceRotation: 0,
        pieceX: 0,
        pieceY: 0,
        nextPieceIndex: 0,
        bag: [],
        score: 0,
        lines: 0,
        tickTimer: null,
        tickIntervalMs: BASE_DROP_MS,
        soundOn: true,
        lastSubmittedFingerprint: "",
      };
      windows.set(message.windowId, window);
      resetGame(window);
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
        frameTimings.finishFrame(message.frameId, "discarded: unknown blocks window");
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
      // The player can't see the board while backgrounded, so don't let
      // gravity keep running.
      if (!window.foreground && window.phase === "playing") window.phase = "paused";
      updateTickTimer(window);
      if (window.foreground) renderAndSubmit(window, 0);
      break;
    }
    case "screen":
      screenOn = message.on;
      for (const window of windows.values()) {
        if (!screenOn && window.phase === "playing") window.phase = "paused";
        updateTickTimer(window);
      }
      break;
  }
};

/**
 * Input and render messages only ever target the shell's foreground window,
 * so a focused message proves this window is foreground. This backstops the
 * "foreground" message itself, which can be lost when it is posted while a
 * freshly spawned worker is still evaluating its bundle (seen on the very
 * first launch: gravity never started because foreground stayed false).
 */
function inferForeground(window: BlocksWindow, focused: boolean): void {
  if (!focused || window.foreground) return;
  window.foreground = true;
  updateTickTimer(window);
}

/**
 * Fire a buzzer effect. Non-blocking: the firmware's sequencer plays the
 * steps on its own timer, and the Java call is safe from the worker thread
 * (same path as frame submission). Effects never exceed one message, so no
 * phrase pacing is needed.
 */
function playSfx(window: BlocksWindow, steps: Step[]): void {
  if (!window.soundOn || steps.length === 0) return;
  try {
    const communicator = com.faceclaw.app.FaceclawBleCommunicator.getActive();
    if (!communicator) return;
    communicator.playBuzzerSequence(buildSoundSequencePayload(steps).buffer);
  } catch (error) {
    console.warn(`blocks sfx failed: ${error}`);
  }
}

/** The window's long-press menu (sound toggle + default entries). */
function openWindowMenu(window: BlocksWindow): void {
  windowMenu(window).open([
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

function windowMenu(window: BlocksWindow): WindowMenu {
  if (!window.menu) {
    window.menu = new WindowMenu({
      size: { width: window.viewportWidth, height: window.viewportHeight },
      paintBase: () => paintContent(window),
      isFocused: () => window.focused,
    });
  }
  return window.menu;
}

function handleInput(window: BlocksWindow, event: InputEvent, frameId: number): void {
  // An open window menu owns all input (it closes itself via pop); menus are
  // list UIs, so watch swipes take their standard fallback meanings there.
  if (window.menu?.isOpen()) {
    window.menu
      .handleInput(directionalFallback(event))
      .catch((error) => console.error(`blocks menu input failed: ${error}`))
      .then(() => renderAndSubmit(window, frameId));
    return;
  }

  if (window.phase === "playing") {
    handlePlayingInput(window, event, frameId);
  } else {
    handleIdleInput(window, event, frameId);
  }
}

function handlePlayingInput(window: BlocksWindow, event: InputEvent, frameId: number): void {
  switch (event.type) {
    case "scroll-up":
    case "swipe-left":
      tryMove(window, -1, 0);
      break;
    case "scroll-down":
    case "swipe-right":
      tryMove(window, 1, 0);
      break;
    // Watch swipes are spatial: left/right move the piece, up rotates it,
    // down hard-drops (like long-press).
    case "swipe-up":
      tryRotate(window);
      break;
    case "swipe-down":
      hardDrop(window);
      break;
    case "click":
      tryRotate(window);
      break;
    case "long-press":
      hardDrop(window);
      break;
    case "double-click":
      window.phase = "paused";
      updateTickTimer(window);
      playSfx(window, SFX_PAUSE);
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: blocks ignored input");
      return;
  }
  renderAndSubmit(window, frameId);
}

/** Input while paused or game over. Swipes take their standard fallback meanings. */
function handleIdleInput(window: BlocksWindow, event: InputEvent, frameId: number): void {
  switch (directionalFallback(event).type) {
    case "click":
      if (window.phase === "game-over") resetGame(window);
      window.phase = "playing";
      updateTickTimer(window);
      playSfx(window, SFX_RESUME);
      break;
    case "double-click":
      frameTimings.finishFrame(frameId, "discarded: blocks yielded focus");
      post({ type: "yield-focus", windowId: window.windowId });
      return;
    case "long-press":
      openWindowMenu(window);
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: blocks ignored input");
      return;
  }
  renderAndSubmit(window, frameId);
}

function resetGame(window: BlocksWindow): void {
  window.board.fill(0);
  window.score = 0;
  window.lines = 0;
  window.phase = "playing";
  window.bag = [];
  window.nextPieceIndex = drawFromBag(window);
  spawnPiece(window);
  updateTickTimer(window);
}

function drawFromBag(window: BlocksWindow): number {
  if (window.bag.length === 0) {
    window.bag = PIECE_DEFS.map((_, index) => index);
    for (let i = window.bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [window.bag[i], window.bag[j]] = [window.bag[j]!, window.bag[i]!];
    }
  }
  return window.bag.pop()!;
}

/** Spawn the queued piece at the top; a blocked spawn ends the game. */
function spawnPiece(window: BlocksWindow): void {
  window.pieceIndex = window.nextPieceIndex;
  window.nextPieceIndex = drawFromBag(window);
  window.pieceRotation = 0;
  const size = PIECE_DEFS[window.pieceIndex]!.size;
  window.pieceX = Math.floor((COLS - size) / 2);
  // Start with the piece's topmost cell in row 0.
  window.pieceY = -Math.min(...pieceCells(window).map(([, y]) => y));
  if (collides(window, window.pieceX, window.pieceY, window.pieceRotation)) {
    window.phase = "game-over";
    updateTickTimer(window);
  }
}

function pieceCells(window: BlocksWindow): Array<[number, number]> {
  return PIECE_ROTATIONS[window.pieceIndex]![window.pieceRotation]!;
}

function collides(window: BlocksWindow, atX: number, atY: number, rotation: number): boolean {
  for (const [cx, cy] of PIECE_ROTATIONS[window.pieceIndex]![rotation]!) {
    const x = atX + cx;
    const y = atY + cy;
    if (x < 0 || x >= COLS || y >= ROWS) return true;
    if (y >= 0 && window.board[y * COLS + x] !== 0) return true;
  }
  return false;
}

function tryMove(window: BlocksWindow, dx: number, dy: number): boolean {
  if (collides(window, window.pieceX + dx, window.pieceY + dy, window.pieceRotation)) return false;
  window.pieceX += dx;
  window.pieceY += dy;
  return true;
}

function tryRotate(window: BlocksWindow): void {
  const rotation = (window.pieceRotation + 1) % 4;
  for (const kick of KICK_OFFSETS) {
    if (!collides(window, window.pieceX + kick, window.pieceY, rotation)) {
      window.pieceX += kick;
      window.pieceRotation = rotation;
      return;
    }
  }
}

function hardDrop(window: BlocksWindow): void {
  let dropped = 0;
  while (tryMove(window, 0, 1)) dropped++;
  window.score += dropped * HARD_DROP_POINTS_PER_ROW;
  lockPiece(window, true);
}

/** One gravity step: descend, or lock and spawn the next piece. */
function tick(window: BlocksWindow): void {
  if (window.phase !== "playing") return;
  if (!tryMove(window, 0, 1)) lockPiece(window);
  renderAndSubmit(window, 0);
}

function lockPiece(window: BlocksWindow, fromHardDrop = false): void {
  const shade = PIECE_DEFS[window.pieceIndex]!.shade;
  let lockedAboveTop = false;
  for (const [cx, cy] of pieceCells(window)) {
    const x = window.pieceX + cx;
    const y = window.pieceY + cy;
    if (y < 0) {
      lockedAboveTop = true;
      continue;
    }
    window.board[y * COLS + x] = shade;
  }
  if (lockedAboveTop) {
    window.phase = "game-over";
    updateTickTimer(window);
    playSfx(window, SFX_GAME_OVER);
    return;
  }
  const levelBefore = level(window);
  const cleared = clearLines(window);
  spawnPiece(window);
  // Score changes may have crossed a speed step.
  updateTickTimer(window);
  // One sound per lock, most newsworthy event first.
  if (window.phase === "game-over") {
    playSfx(window, SFX_GAME_OVER);
  } else if (level(window) > levelBefore) {
    playSfx(window, SFX_LEVEL_UP);
  } else if (cleared > 0) {
    playSfx(window, SFX_LINE_CLEAR[cleared] ?? SFX_LINE_CLEAR[4]!);
  } else {
    playSfx(window, fromHardDrop ? SFX_HARD_DROP : SFX_LOCK);
  }
}

function clearLines(window: BlocksWindow): number {
  let cleared = 0;
  for (let y = ROWS - 1; y >= 0; y--) {
    let full = true;
    for (let x = 0; x < COLS; x++) {
      if (window.board[y * COLS + x] === 0) {
        full = false;
        break;
      }
    }
    if (!full) continue;
    // Shift everything above this row down one and re-check the same row.
    window.board.copyWithin(COLS, 0, y * COLS);
    window.board.fill(0, 0, COLS);
    cleared++;
    y++;
  }
  if (cleared > 0) {
    window.score += LINE_SCORES[cleared]! * level(window);
    window.lines += cleared;
  }
  return cleared;
}

function level(window: BlocksWindow): number {
  return 1 + Math.floor(window.lines / LINES_PER_LEVEL);
}

function dropIntervalMs(window: BlocksWindow): number {
  const steps = Math.floor(window.score / SPEED_STEP_SCORE);
  return Math.max(MIN_DROP_MS, Math.round(BASE_DROP_MS * Math.pow(0.88, steps)));
}

/** Keep the gravity interval running exactly when the game is live and visible. */
function updateTickTimer(window: BlocksWindow): void {
  const intervalMs = dropIntervalMs(window);
  const shouldRun = window.phase === "playing" && window.foreground && screenOn;
  if (window.tickTimer !== null && (!shouldRun || intervalMs !== window.tickIntervalMs)) {
    clearInterval(window.tickTimer);
    window.tickTimer = null;
  }
  if (shouldRun && window.tickTimer === null) {
    window.tickIntervalMs = intervalMs;
    window.tickTimer = setInterval(() => tick(window), intervalMs);
  }
}

function paint(window: BlocksWindow): Plane[] {
  if (window.menu?.isOpen()) {
    return window.menu.paint();
  }
  return singlePlane(paintContent(window));
}

function paintContent(window: BlocksWindow): GrayImage {
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  image.drawRect(BOARD_X - 2, BOARD_Y - 2, COLS * CELL + 4, ROWS * CELL + 4, 120);
  if (window.phase === "paused") {
    // Hide the board so pausing can't be used to study the stack.
    drawCenteredIn(image, mediumFont, BOARD_X, COLS * CELL, BOARD_Y + 90, "PAUSED", 230);
    drawCenteredIn(image, smallFont, BOARD_X, COLS * CELL, BOARD_Y + 130, `${GESTURE_CLICK} resume`, 150);
    drawCenteredIn(image, smallFont, BOARD_X, COLS * CELL, BOARD_Y + 150, `${GESTURE_DOUBLE_CLICK} leave`, 150);
  } else {
    paintBoard(image, window);
    if (window.phase === "game-over") paintGameOver(image, window);
  }
  paintPanel(image, window);
  return image;
}

function paintBoard(image: GrayImage, window: BlocksWindow): void {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const shade = window.board[y * COLS + x]!;
      if (shade !== 0) drawCell(image, x, y, shade);
    }
  }
  if (window.phase !== "playing") return;

  // Ghost outline at the piece's landing position.
  let ghostY = window.pieceY;
  while (!collides(window, window.pieceX, ghostY + 1, window.pieceRotation)) ghostY++;
  const shade = PIECE_DEFS[window.pieceIndex]!.shade;
  for (const [cx, cy] of pieceCells(window)) {
    const x = window.pieceX + cx;
    if (ghostY + cy >= 0 && ghostY > window.pieceY) {
      image.drawRect(BOARD_X + x * CELL, BOARD_Y + (ghostY + cy) * CELL, CELL - 1, CELL - 1, 70);
    }
    if (window.pieceY + cy >= 0) drawCell(image, x, window.pieceY + cy, shade);
  }
}

function drawCell(image: GrayImage, x: number, y: number, shade: number): void {
  image.fillRect(BOARD_X + x * CELL, BOARD_Y + y * CELL, CELL - 1, CELL - 1, shade);
}

function paintGameOver(image: GrayImage, window: BlocksWindow): void {
  const boxY = BOARD_Y + 70;
  image.fillRect(BOARD_X, boxY, COLS * CELL, 100, 0);
  image.drawRect(BOARD_X + 4, boxY + 4, COLS * CELL - 8, 92, 150);
  drawCenteredIn(image, mediumFont, BOARD_X, COLS * CELL, boxY + 16, "GAME", 245);
  drawCenteredIn(image, mediumFont, BOARD_X, COLS * CELL, boxY + 40, "OVER", 245);
  drawCenteredIn(image, smallFont, BOARD_X, COLS * CELL, boxY + 70, `${GESTURE_CLICK} new game`, 150);
}

function paintPanel(image: GrayImage, window: BlocksWindow): void {
  image.drawText(smallFont, PANEL_X, BOARD_Y, "Next", 140);
  const previewBoxSize = 4 * CELL + 16;
  const previewY = BOARD_Y + 22;
  image.drawRect(PANEL_X, previewY, previewBoxSize, previewBoxSize, 90);
  const def = PIECE_DEFS[window.nextPieceIndex]!;
  const cells = PIECE_ROTATIONS[window.nextPieceIndex]![0]!;
  const minX = Math.min(...cells.map(([x]) => x));
  const maxX = Math.max(...cells.map(([x]) => x));
  const minY = Math.min(...cells.map(([, y]) => y));
  const maxY = Math.max(...cells.map(([, y]) => y));
  const offsetX = PANEL_X + Math.round((previewBoxSize - (maxX - minX + 1) * CELL) / 2);
  const offsetY = previewY + Math.round((previewBoxSize - (maxY - minY + 1) * CELL) / 2);
  for (const [cx, cy] of cells) {
    image.fillRect(offsetX + (cx - minX) * CELL, offsetY + (cy - minY) * CELL, CELL - 1, CELL - 1, def.shade);
  }

  const statX = PANEL_X + previewBoxSize + 40;
  drawStat(image, statX, BOARD_Y + 10, "Score", String(window.score));
  drawStat(image, statX, BOARD_Y + 70, "Lines", String(window.lines));
  drawStat(image, statX, BOARD_Y + 130, "Level", String(level(window)));

  image.drawText(smallFont, PANEL_X, 200, `${GESTURE_SCROLL} move   ${GESTURE_CLICK} rotate`, 115);
  image.drawText(smallFont, PANEL_X, 222, `${GESTURE_LONG_PRESS} drop   ${GESTURE_DOUBLE_CLICK} pause`, 115);
}

function drawStat(image: GrayImage, x: number, y: number, label: string, value: string): void {
  image.drawText(smallFont, x, y, label, 140);
  image.drawText(largeFont, x, y + 18, value, 235);
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

function renderAndSubmit(window: BlocksWindow, inputFrameId: number): void {
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${window.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => paint(window)),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = planesFingerprint(planes);
    if (fingerprint === window.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: blocks content unchanged");
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
    frameTimings.finishFrame(frameId, "discarded: blocks render failed");
    console.error(`blocks worker render failed: ${error}`);
  }
}
