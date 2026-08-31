/**
 * Minesweeper app worker. One singleton window holds the whole game: a fixed
 * 12×9 board with a difficulty setting that varies the mine count. Mines are
 * placed on the first reveal (never under or adjacent to it), and the clock
 * runs only while the game is live, foreground, and the screen is on.
 *
 * Controls (in play) are a two-layer selection. Row-select: scroll picks a
 * row, click switches to column-select, double-click pauses. Column-select:
 * scroll moves along the row, click reveals (or chords a satisfied number),
 * long-press toggles a flag, double-click returns to row-select.
 * Watch swipes skip the two-layer scheme and move the cell cursor in four
 * directions; a watch double-click pauses directly.
 * Paused/won/lost: click resumes or starts a new game, double-click yields
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
  isWatchInput,
  type InputEvent,
} from "../../ui/gestures";
import { clamp } from "../../util/numeric-util";

declare const global: any;
declare const com: any;

const largeFont = getFont("terminus32");
const mediumFont = getFont("terminus24");
const smallFont = getDefaultSmallFont();

const COLS = 12;
const ROWS = 9;
const CELL = 26;
const BOARD_X = 14;
const BOARD_Y = 14;
const PANEL_X = BOARD_X + COLS * CELL + 28;

const DIFFICULTIES = [
  { name: "Easy", mines: 14 },
  { name: "Medium", mines: 20 },
  { name: "Hard", mines: 26 },
] as const;

/** Number glyph shades by adjacent-mine count; higher counts read brighter. */
const COUNT_SHADES = [0, 140, 170, 200, 220, 235, 245, 250, 250];

const CELL_HIDDEN = 0;
const CELL_REVEALED = 1;
const CELL_FLAGGED = 2;

/** Buzzer effects, tuned soft like the Blocks ones (shared piezo). */
const SFX_REVEAL: Step[] = [{ freq: 660, duty: 40, ms: 15 }];
const SFX_FLAG: Step[] = [{ freq: 880, duty: 40, ms: 30 }];
const SFX_UNFLAG: Step[] = [{ freq: 550, duty: 40, ms: 30 }];
const SFX_BOOM: Step[] = [
  { freq: 220, duty: 55, ms: 80 },
  { freq: 140, duty: 55, ms: 120 },
  { freq: 90, duty: 60, ms: 320 },
];
const SFX_WIN: Step[] = [
  { freq: 1047, ms: 55 },
  { freq: 1319, ms: 55 },
  { freq: 1568, ms: 55 },
  { freq: 2093, ms: 70 },
  { freq: 1, duty: 0, ms: 30 },
  { freq: 2093, ms: 160 },
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

type GamePhase = "playing" | "paused" | "won" | "lost";

type MinesweeperWindow = {
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
  difficultyIndex: number;
  /** 1 = mine at this cell; empty until the first reveal places the mines. */
  mines: Uint8Array;
  /** Adjacent-mine counts, precomputed at placement. */
  counts: Uint8Array;
  /** Per-cell CELL_HIDDEN / CELL_REVEALED / CELL_FLAGGED. */
  cellState: Uint8Array;
  minesPlaced: boolean;
  cursorX: number;
  cursorY: number;
  /** Two-layer selection: pick a row first, then a cell along it. */
  selectMode: "row" | "column";
  flagCount: number;
  revealedCount: number;
  /** The mine that ended the game, painted highlighted; -1 otherwise. */
  explodedIndex: number;
  /** Clock: accumulated play time plus the live segment since runningSinceMs. */
  elapsedMs: number;
  runningSinceMs: number | null;
  tickTimer: ReturnType<typeof setInterval> | null;
  soundOn: boolean;
  lastSubmittedFingerprint: string;
};

const windows = new Map<string, MinesweeperWindow>();
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
      const window: MinesweeperWindow = {
        windowId: message.windowId,
        surfaceId: message.surfaceId,
        viewportWidth: message.viewport.width,
        viewportHeight: message.viewport.height,
        foreground: false,
        focused: false,
        menu: null,
        phase: "playing",
        difficultyIndex: 0,
        mines: new Uint8Array(COLS * ROWS),
        counts: new Uint8Array(COLS * ROWS),
        cellState: new Uint8Array(COLS * ROWS),
        minesPlaced: false,
        cursorX: Math.floor(COLS / 2),
        cursorY: Math.floor(ROWS / 2),
        selectMode: "row",
        flagCount: 0,
        revealedCount: 0,
        explodedIndex: -1,
        elapsedMs: 0,
        runningSinceMs: null,
        tickTimer: null,
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
        frameTimings.finishFrame(message.frameId, "discarded: unknown minesweeper window");
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
      // The player can't see the board while backgrounded, so don't let the
      // clock keep running.
      if (!window.foreground && window.phase === "playing") window.phase = "paused";
      syncClock(window);
      if (window.foreground) renderAndSubmit(window, 0);
      break;
    }
    case "screen":
      screenOn = message.on;
      for (const window of windows.values()) {
        if (!screenOn && window.phase === "playing") window.phase = "paused";
        syncClock(window);
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
function inferForeground(window: MinesweeperWindow, focused: boolean): void {
  if (!focused || window.foreground) return;
  window.foreground = true;
  syncClock(window);
}

/**
 * Fire a buzzer effect. Non-blocking: the firmware's sequencer plays the
 * steps on its own timer, and the Java call is safe from the worker thread.
 */
function playSfx(window: MinesweeperWindow, steps: Step[]): void {
  if (!window.soundOn || steps.length === 0) return;
  try {
    const communicator = com.faceclaw.app.FaceclawBleCommunicator.getActive();
    if (!communicator) return;
    communicator.playBuzzerSequence(buildSoundSequencePayload(steps).buffer);
  } catch (error) {
    console.warn(`minesweeper sfx failed: ${error}`);
  }
}

/** The window's long-press menu (game actions + default entries). */
function openWindowMenu(window: MinesweeperWindow): void {
  const nextDifficulty = DIFFICULTIES[(window.difficultyIndex + 1) % DIFFICULTIES.length]!;
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
      label: `Difficulty: ${DIFFICULTIES[window.difficultyIndex]!.name} → ${nextDifficulty.name}`,
      onSelect: (ctx) => {
        ctx.stack.pop();
        window.difficultyIndex = (window.difficultyIndex + 1) % DIFFICULTIES.length;
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

function windowMenu(window: MinesweeperWindow): WindowMenu {
  if (!window.menu) {
    window.menu = new WindowMenu({
      size: { width: window.viewportWidth, height: window.viewportHeight },
      paintBase: () => paintContent(window),
      isFocused: () => window.focused,
    });
  }
  return window.menu;
}

function handleInput(window: MinesweeperWindow, event: InputEvent, frameId: number): void {
  // An open window menu owns all input (it closes itself via pop); menus are
  // list UIs, so watch swipes take their standard fallback meanings there.
  if (window.menu?.isOpen()) {
    window.menu
      .handleInput(directionalFallback(event))
      .catch((error) => console.error(`minesweeper menu input failed: ${error}`))
      .then(() => renderAndSubmit(window, frameId));
    return;
  }

  if (window.phase === "playing") {
    handlePlayingInput(window, event, frameId);
  } else {
    handleIdleInput(window, event, frameId);
  }
}

function handlePlayingInput(window: MinesweeperWindow, event: InputEvent, frameId: number): void {
  // The watch's swipes move the cell cursor in four directions; its scheme
  // has no row-select layer (as in the launcher), so any watch input drops
  // to cell selection first and its double-click pauses directly.
  const watch = isWatchInput(event);
  if (watch) window.selectMode = "column";
  const rowMode = window.selectMode === "row";
  switch (event.type) {
    case "swipe-up":
      window.cursorY = clamp(window.cursorY - 1, 0, ROWS - 1);
      break;
    case "swipe-down":
      window.cursorY = clamp(window.cursorY + 1, 0, ROWS - 1);
      break;
    case "swipe-left":
      window.cursorX = clamp(window.cursorX - 1, 0, COLS - 1);
      break;
    case "swipe-right":
      window.cursorX = clamp(window.cursorX + 1, 0, COLS - 1);
      break;
    case "scroll-up":
      if (rowMode) {
        window.cursorY = clamp(window.cursorY - 1, 0, ROWS - 1);
      } else {
        window.cursorX = clamp(window.cursorX - 1, 0, COLS - 1);
      }
      break;
    case "scroll-down":
      if (rowMode) {
        window.cursorY = clamp(window.cursorY + 1, 0, ROWS - 1);
      } else {
        window.cursorX = clamp(window.cursorX + 1, 0, COLS - 1);
      }
      break;
    case "click":
      if (rowMode) {
        window.selectMode = "column";
      } else {
        revealAtCursor(window);
      }
      break;
    case "long-press":
      if (rowMode) {
        frameTimings.finishFrame(frameId, "discarded: minesweeper ignored input");
        return;
      }
      toggleFlag(window);
      break;
    case "double-click":
      if (rowMode || watch) {
        window.phase = "paused";
        syncClock(window);
        playSfx(window, SFX_PAUSE);
      } else {
        window.selectMode = "row";
      }
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: minesweeper ignored input");
      return;
  }
  renderAndSubmit(window, frameId);
}

/** Input while paused, won, or lost. Swipes take their standard fallback meanings. */
function handleIdleInput(window: MinesweeperWindow, event: InputEvent, frameId: number): void {
  switch (directionalFallback(event).type) {
    case "click":
      if (window.phase === "paused") {
        window.phase = "playing";
      } else {
        resetGame(window);
      }
      syncClock(window);
      playSfx(window, SFX_RESUME);
      break;
    case "double-click":
      frameTimings.finishFrame(frameId, "discarded: minesweeper yielded focus");
      post({ type: "yield-focus", windowId: window.windowId });
      return;
    case "long-press":
      openWindowMenu(window);
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: minesweeper ignored input");
      return;
  }
  renderAndSubmit(window, frameId);
}

function resetGame(window: MinesweeperWindow): void {
  window.mines.fill(0);
  window.counts.fill(0);
  window.cellState.fill(CELL_HIDDEN);
  window.minesPlaced = false;
  window.flagCount = 0;
  window.revealedCount = 0;
  window.explodedIndex = -1;
  window.elapsedMs = 0;
  window.runningSinceMs = null;
  window.phase = "playing";
  window.selectMode = "row";
  syncClock(window);
}

function mineCount(window: MinesweeperWindow): number {
  return DIFFICULTIES[window.difficultyIndex]!.mines;
}

function forEachNeighbor(x: number, y: number, callback: (nx: number, ny: number) => void): void {
  for (let ny = Math.max(0, y - 1); ny <= Math.min(ROWS - 1, y + 1); ny++) {
    for (let nx = Math.max(0, x - 1); nx <= Math.min(COLS - 1, x + 1); nx++) {
      if (nx !== x || ny !== y) callback(nx, ny);
    }
  }
}

/** Place mines everywhere except the 3×3 around the first reveal, then count. */
function placeMines(window: MinesweeperWindow, safeX: number, safeY: number): void {
  const candidates: number[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (Math.abs(x - safeX) <= 1 && Math.abs(y - safeY) <= 1) continue;
      candidates.push(y * COLS + x);
    }
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
  }
  for (const index of candidates.slice(0, mineCount(window))) {
    window.mines[index] = 1;
  }
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      let count = 0;
      forEachNeighbor(x, y, (nx, ny) => {
        if (window.mines[ny * COLS + nx]) count++;
      });
      window.counts[y * COLS + x] = count;
    }
  }
  window.minesPlaced = true;
  syncClock(window);
}

/** Reveal a cell, flood-filling zero-count regions. Returns true on a mine. */
function revealCell(window: MinesweeperWindow, x: number, y: number): boolean {
  const index = y * COLS + x;
  if (window.cellState[index] !== CELL_HIDDEN) return false;
  if (window.mines[index]) {
    window.explodedIndex = index;
    loseGame(window);
    return true;
  }
  const stack = [index];
  window.cellState[index] = CELL_REVEALED;
  window.revealedCount++;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (window.counts[current] !== 0) continue;
    forEachNeighbor(current % COLS, Math.floor(current / COLS), (nx, ny) => {
      const neighbor = ny * COLS + nx;
      if (window.cellState[neighbor] !== CELL_HIDDEN) return;
      window.cellState[neighbor] = CELL_REVEALED;
      window.revealedCount++;
      stack.push(neighbor);
    });
  }
  return false;
}

function revealAtCursor(window: MinesweeperWindow): void {
  const { cursorX, cursorY } = window;
  const index = cursorY * COLS + cursorX;
  if (window.cellState[index] === CELL_FLAGGED) return;

  if (window.cellState[index] === CELL_REVEALED) {
    chordAtCursor(window);
    return;
  }
  if (!window.minesPlaced) placeMines(window, cursorX, cursorY);
  if (!revealCell(window, cursorX, cursorY)) {
    playSfx(window, SFX_REVEAL);
    checkWin(window);
  }
}

/**
 * Chord: clicking a revealed number whose flag count is satisfied reveals its
 * remaining hidden neighbors (classic both-buttons shortcut). Wrong flags
 * still explode.
 */
function chordAtCursor(window: MinesweeperWindow): void {
  const { cursorX, cursorY } = window;
  const count = window.counts[cursorY * COLS + cursorX]!;
  if (count === 0) return;
  let flags = 0;
  forEachNeighbor(cursorX, cursorY, (nx, ny) => {
    if (window.cellState[ny * COLS + nx] === CELL_FLAGGED) flags++;
  });
  if (flags !== count) return;
  let exploded = false;
  let revealedAny = false;
  forEachNeighbor(cursorX, cursorY, (nx, ny) => {
    if (exploded || window.cellState[ny * COLS + nx] !== CELL_HIDDEN) return;
    revealedAny = true;
    if (revealCell(window, nx, ny)) exploded = true;
  });
  if (!exploded && revealedAny) {
    playSfx(window, SFX_REVEAL);
    checkWin(window);
  }
}

function toggleFlag(window: MinesweeperWindow): void {
  const index = window.cursorY * COLS + window.cursorX;
  if (window.cellState[index] === CELL_REVEALED) return;
  if (window.cellState[index] === CELL_FLAGGED) {
    window.cellState[index] = CELL_HIDDEN;
    window.flagCount--;
    playSfx(window, SFX_UNFLAG);
  } else {
    window.cellState[index] = CELL_FLAGGED;
    window.flagCount++;
    playSfx(window, SFX_FLAG);
  }
}

function checkWin(window: MinesweeperWindow): void {
  if (window.revealedCount !== COLS * ROWS - mineCount(window)) return;
  window.phase = "won";
  // Flag the remaining mines for the player; the counter drops to zero.
  for (let index = 0; index < window.mines.length; index++) {
    if (window.mines[index] && window.cellState[index] === CELL_HIDDEN) {
      window.cellState[index] = CELL_FLAGGED;
    }
  }
  window.flagCount = mineCount(window);
  syncClock(window);
  playSfx(window, SFX_WIN);
}

function loseGame(window: MinesweeperWindow): void {
  window.phase = "lost";
  syncClock(window);
  playSfx(window, SFX_BOOM);
}

/**
 * Keep the clock and the once-a-second repaint interval running exactly when
 * play time is accruing: game live (mines placed), foreground, screen on.
 */
function syncClock(window: MinesweeperWindow): void {
  const shouldRun =
    window.phase === "playing" && window.minesPlaced && window.foreground && screenOn;
  const now = Date.now();
  if (shouldRun && window.runningSinceMs === null) {
    window.runningSinceMs = now;
  } else if (!shouldRun && window.runningSinceMs !== null) {
    window.elapsedMs += now - window.runningSinceMs;
    window.runningSinceMs = null;
  }
  if (shouldRun && window.tickTimer === null) {
    window.tickTimer = setInterval(() => renderAndSubmit(window, 0), 1000);
  } else if (!shouldRun && window.tickTimer !== null) {
    clearInterval(window.tickTimer);
    window.tickTimer = null;
  }
}

function elapsedMs(window: MinesweeperWindow): number {
  const runningMs = window.runningSinceMs === null ? 0 : Date.now() - window.runningSinceMs;
  return window.elapsedMs + runningMs;
}

function paint(window: MinesweeperWindow): Plane[] {
  if (window.menu?.isOpen()) {
    return window.menu.paint();
  }
  return singlePlane(paintContent(window));
}

function paintContent(window: MinesweeperWindow): GrayImage {
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  image.drawRect(BOARD_X - 2, BOARD_Y - 2, COLS * CELL + 4, ROWS * CELL + 4, 120);
  if (window.phase === "paused") {
    // Hide the board so pausing can't be used to study it off the clock.
    drawCenteredIn(image, mediumFont, BOARD_X, COLS * CELL, BOARD_Y + 80, "PAUSED", 230);
    drawCenteredIn(image, smallFont, BOARD_X, COLS * CELL, BOARD_Y + 120, `${GESTURE_CLICK} resume`, 150);
    drawCenteredIn(image, smallFont, BOARD_X, COLS * CELL, BOARD_Y + 140, `${GESTURE_DOUBLE_CLICK} leave`, 150);
  } else {
    paintBoard(image, window);
  }
  paintPanel(image, window);
  return image;
}

function paintBoard(image: GrayImage, window: MinesweeperWindow): void {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      paintCell(image, window, x, y);
    }
  }
  // Cursor: a double bright outline so it stays visible over any cell. In
  // row-select it spans the whole selected row; in column-select it marks the
  // cell (games over show neither).
  if (window.phase !== "playing") return;
  const cx = BOARD_X + window.cursorX * CELL;
  const cy = BOARD_Y + window.cursorY * CELL;
  if (window.selectMode === "row") {
    image.drawRect(BOARD_X - 1, cy - 1, COLS * CELL + 1, CELL + 1, 255);
    image.drawRect(BOARD_X, cy, COLS * CELL - 1, CELL - 1, 255);
  } else {
    image.drawRect(cx - 1, cy - 1, CELL + 1, CELL + 1, 255);
    image.drawRect(cx, cy, CELL - 1, CELL - 1, 255);
  }
}

function paintCell(image: GrayImage, window: MinesweeperWindow, x: number, y: number): void {
  const index = y * COLS + x;
  const cx = BOARD_X + x * CELL;
  const cy = BOARD_Y + y * CELL;
  const state = window.cellState[index]!;
  const isMine = window.mines[index] === 1;
  const gameOver = window.phase === "lost";

  if (state === CELL_REVEALED || (gameOver && isMine)) {
    if (isMine) {
      // The fatal mine gets an inverted cell so it stands out.
      if (index === window.explodedIndex) image.fillRect(cx, cy, CELL - 1, CELL - 1, 200);
      drawMine(image, cx, cy, index === window.explodedIndex ? 1 : 220);
      return;
    }
    image.drawRect(cx, cy, CELL - 1, CELL - 1, 22);
    const count = window.counts[index]!;
    if (count > 0) {
      const digit = String(count);
      const dx = cx + Math.round((CELL - 1 - mediumFont.measureText(digit)) / 2);
      image.drawText(mediumFont, dx, cy + 1, digit, COUNT_SHADES[count]!);
    }
    return;
  }

  // Hidden (or flagged) cell face.
  image.fillRect(cx, cy, CELL - 1, CELL - 1, 55);
  if (state === CELL_FLAGGED) {
    drawFlag(image, cx, cy, 245);
    // A flag that turned out wrong gets crossed out at game over.
    if (gameOver && !isMine) {
      image.drawLine(cx + 3, cy + 3, cx + CELL - 5, cy + CELL - 5, 255);
      image.drawLine(cx + CELL - 5, cy + 3, cx + 3, cy + CELL - 5, 255);
    }
  }
}

function drawFlag(image: GrayImage, cx: number, cy: number, shade: number): void {
  image.drawLine(cx + 10, cy + 5, cx + 10, cy + 20, shade);
  image.fillRect(cx + 11, cy + 5, 7, 4, shade);
  image.fillRect(cx + 11, cy + 9, 4, 3, shade);
  image.drawLine(cx + 7, cy + 20, cx + 13, cy + 20, shade);
}

function drawMine(image: GrayImage, cx: number, cy: number, shade: number): void {
  const centerX = cx + Math.floor((CELL - 1) / 2);
  const centerY = cy + Math.floor((CELL - 1) / 2);
  // A rounded blob plus four spikes reads as a mine at this size.
  image.fillRoundedRect(centerX - 6, centerY - 6, 13, 13, shade, 6);
  image.drawLine(centerX - 9, centerY, centerX + 9, centerY, shade);
  image.drawLine(centerX, centerY - 9, centerX, centerY + 9, shade);
  image.drawLine(centerX - 7, centerY - 7, centerX + 7, centerY + 7, shade);
  image.drawLine(centerX - 7, centerY + 7, centerX + 7, centerY - 7, shade);
}

function paintPanel(image: GrayImage, window: MinesweeperWindow): void {
  drawStat(image, PANEL_X, BOARD_Y, "Mines", String(mineCount(window) - window.flagCount));
  drawStat(image, PANEL_X, BOARD_Y + 62, "Time", formatElapsed(elapsedMs(window)));
  image.drawText(smallFont, PANEL_X, BOARD_Y + 126, DIFFICULTIES[window.difficultyIndex]!.name, 140);

  if (window.phase === "won" || window.phase === "lost") {
    image.drawText(mediumFont, PANEL_X, BOARD_Y + 152, window.phase === "won" ? "CLEARED!" : "BOOM!", 250);
    image.drawText(smallFont, PANEL_X, BOARD_Y + 178, `${GESTURE_CLICK} new game`, 150);
    image.drawText(smallFont, PANEL_X, BOARD_Y + 198, `${GESTURE_LONG_PRESS} menu`, 150);
  } else if (window.selectMode === "row") {
    image.drawText(smallFont, PANEL_X, 200, `${GESTURE_SCROLL} row   ${GESTURE_CLICK} pick`, 115);
    image.drawText(smallFont, PANEL_X, 222, `${GESTURE_DOUBLE_CLICK} pause`, 115);
  } else {
    image.drawText(smallFont, PANEL_X, 200, `${GESTURE_SCROLL} cell   ${GESTURE_CLICK} dig`, 115);
    image.drawText(smallFont, PANEL_X, 222, `${GESTURE_LONG_PRESS} flag   ${GESTURE_DOUBLE_CLICK} rows`, 115);
  }
}

function drawStat(image: GrayImage, x: number, y: number, label: string, value: string): void {
  image.drawText(smallFont, x, y, label, 140);
  image.drawText(largeFont, x, y + 18, value, 235);
}

function formatElapsed(totalMs: number): string {
  const totalSeconds = Math.floor(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

function renderAndSubmit(window: MinesweeperWindow, inputFrameId: number): void {
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${window.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => paint(window)),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = planesFingerprint(planes);
    if (fingerprint === window.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: minesweeper content unchanged");
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
    frameTimings.finishFrame(frameId, "discarded: minesweeper render failed");
    console.error(`minesweeper worker render failed: ${error}`);
  }
}
