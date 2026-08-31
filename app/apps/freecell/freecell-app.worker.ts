/**
 * Freecell solitaire app worker. One singleton window holds a standard
 * 52-card Freecell game: 8 cascades, 4 free cells, 4 foundations. Red suits
 * render dim and black suits bright, since the display has no color.
 *
 * Controls: scroll moves a cursor through the 16 locations (free cells,
 * foundations, then cascades, wrapping). Click selects a source, then click
 * on a destination moves there; cascade-to-cascade moves take the longest
 * legal run that fits (supermoves via empty cells/columns). Double-click
 * sends the card at the cursor to its foundation, or cancels a pending
 * selection. Long-press opens the window menu (undo, new game, restart).
 * Watch swipes move the cursor spatially: left/right within the row, up/down
 * between the top row (cells + foundations) and the cascades.
 * Safe cards auto-play to the foundations after every move.
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
import type { MenuItem } from "../../ui/menu";
import type { WorkerAppMessage, WorkerAppReply } from "../../ui/shell/worker-window";
import { directionalFallback, GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_LONG_PRESS, type InputEvent } from "../../ui/gestures";

declare const global: any;
declare const com: any;

const largeFont = getFont("terminus32");
const mediumFont = getFont("terminus24");
const labelFont = getFont("terminus16");
const smallFont = getDefaultSmallFont();

/** Cards are 0..51: suit = card % 4 (♠♥♣♦, alternating colors), rank 1..13. */
const SUIT_CHARS = ["♠", "♥", "♣", "♦"] as const;
const RANK_CHARS = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

function suitOf(card: number): number {
  return card % 4;
}
function rankOf(card: number): number {
  return Math.floor(card / 4) + 1;
}
function isRed(card: number): boolean {
  return (card & 1) === 1;
}
function cardLabel(card: number): string {
  return RANK_CHARS[rankOf(card)]! + SUIT_CHARS[suitOf(card)]!;
}

/** Red suits render dimmer than black so card color survives grayscale. */
const BLACK_SHADE = 255;
const RED_SHADE = 150;

const CARD_W = 60;
const CARD_H = 36;
const TOP_Y = 4;
const CASCADE_Y = 48;

/**
 * Cursor locations, in scroll order: free cells 0-3, foundations 0-3 (the
 * top row left to right), then cascades 0-7.
 */
const LOC_CELL0 = 0;
const LOC_FOUNDATION0 = 4;
const LOC_CASCADE0 = 8;
const LOC_COUNT = 16;

/** Buzzer effects, tuned soft like the other games' (shared piezo). */
const SFX_SELECT: Step[] = [{ freq: 880, duty: 40, ms: 20 }];
const SFX_MOVE: Step[] = [{ freq: 660, duty: 40, ms: 15 }];
const SFX_FOUNDATION: Step[] = [{ freq: 1047, duty: 40, ms: 25 }];
const SFX_ERROR: Step[] = [{ freq: 220, duty: 45, ms: 60 }];
const SFX_UNDO: Step[] = [{ freq: 550, duty: 40, ms: 30 }];
/** Also the new-game and sound-toggled-on confirmation. */
const SFX_NEW_GAME: Step[] = [
  { freq: 880, duty: 40, ms: 60 },
  { freq: 1319, duty: 40, ms: 110 },
];
const SFX_WIN: Step[] = [
  { freq: 1047, ms: 55 },
  { freq: 1319, ms: 55 },
  { freq: 1568, ms: 55 },
  { freq: 2093, ms: 70 },
  { freq: 1, duty: 0, ms: 30 },
  { freq: 2093, ms: 160 },
];

type Snapshot = {
  cascades: number[][];
  cells: Array<number | null>;
  foundations: Array<number | null>;
  moves: number;
};

type FreecellWindow = {
  windowId: string;
  surfaceId: string;
  viewportWidth: number;
  viewportHeight: number;
  foreground: boolean;
  /** Whether this window is the shell's input target (pushed with each message). */
  focused: boolean;
  /** Long-press window menu; created on first open. */
  menu: WindowMenu | null;
  phase: "playing" | "won";
  cascades: number[][];
  cells: Array<number | null>;
  /** Top card of each foundation pile, or null while empty. */
  foundations: Array<number | null>;
  /** The shuffle behind the current game, kept so a deal can be restarted. */
  dealOrder: number[];
  undoStack: Snapshot[];
  moves: number;
  cursor: number;
  /** Location of the pending source selection, if any. */
  selected: number | null;
  soundOn: boolean;
  lastSubmittedFingerprint: string;
};

const windows = new Map<string, FreecellWindow>();

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
      const window: FreecellWindow = {
        windowId: message.windowId,
        surfaceId: message.surfaceId,
        viewportWidth: message.viewport.width,
        viewportHeight: message.viewport.height,
        foreground: false,
        focused: false,
        menu: null,
        phase: "playing",
        cascades: [],
        cells: [null, null, null, null],
        foundations: [null, null, null, null],
        dealOrder: [],
        undoStack: [],
        moves: 0,
        cursor: LOC_CASCADE0,
        selected: null,
        soundOn: true,
        lastSubmittedFingerprint: "",
      };
      newGame(window, false);
      windows.set(message.windowId, window);
      break;
    }
    case "close-window":
      windows.delete(message.windowId);
      break;
    case "input": {
      const window = windows.get(message.windowId);
      if (!window) {
        frameTimings.finishFrame(message.frameId, "discarded: unknown freecell window");
        break;
      }
      window.focused = message.focused;
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
      renderAndSubmit(window, 0);
      break;
    }
    case "foreground": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.foreground = message.foreground;
      window.focused = message.focused;
      if (window.foreground) renderAndSubmit(window, 0);
      break;
    }
  }
};

/**
 * Fire a buzzer effect. Non-blocking: the firmware's sequencer plays the
 * steps on its own timer, and the Java call is safe from the worker thread.
 */
function playSfx(window: FreecellWindow, steps: Step[]): void {
  if (!window.soundOn || steps.length === 0) return;
  try {
    const communicator = com.faceclaw.app.FaceclawBleCommunicator.getActive();
    if (!communicator) return;
    communicator.playBuzzerSequence(buildSoundSequencePayload(steps).buffer);
  } catch (error) {
    console.warn(`freecell sfx failed: ${error}`);
  }
}

/** The window's long-press menu (game actions + default entries). */
function openWindowMenu(window: FreecellWindow): void {
  const items: MenuItem[] = [];
  if (window.undoStack.length > 0 && window.phase === "playing") {
    items.push({
      label: `Undo (${window.undoStack.length})`,
      onSelect: (ctx) => {
        ctx.stack.pop();
        undoMove(window);
      },
    });
  }
  items.push(
    {
      label: "New game",
      onSelect: (ctx) => {
        ctx.stack.pop();
        newGame(window, false);
        playSfx(window, SFX_NEW_GAME);
      },
    },
    {
      label: "Restart this deal",
      onSelect: (ctx) => {
        ctx.stack.pop();
        newGame(window, true);
        playSfx(window, SFX_NEW_GAME);
      },
    },
    {
      label: window.soundOn ? "Sound: on" : "Sound: off",
      onSelect: (ctx) => {
        ctx.stack.pop();
        window.soundOn = !window.soundOn;
        if (window.soundOn) playSfx(window, SFX_NEW_GAME);
      },
    },
  );
  windowMenu(window).open([...items, ...defaultWindowMenuItems(window.windowId, post)]);
}

function windowMenu(window: FreecellWindow): WindowMenu {
  if (!window.menu) {
    window.menu = new WindowMenu({
      size: { width: window.viewportWidth, height: window.viewportHeight },
      paintBase: () => paintContent(window),
      isFocused: () => window.focused,
    });
  }
  return window.menu;
}

function handleInput(window: FreecellWindow, event: InputEvent, frameId: number): void {
  // An open window menu owns all input (it closes itself via pop); menus are
  // list UIs, so watch swipes take their standard fallback meanings there.
  if (window.menu?.isOpen()) {
    window.menu
      .handleInput(directionalFallback(event))
      .catch((error) => console.error(`freecell menu input failed: ${error}`))
      .then(() => renderAndSubmit(window, frameId));
    return;
  }

  if (window.phase === "playing") {
    handlePlayingInput(window, event, frameId);
  } else {
    handleWonInput(window, event, frameId);
  }
}

function handlePlayingInput(window: FreecellWindow, event: InputEvent, frameId: number): void {
  switch (event.type) {
    case "scroll-up":
      window.cursor = (window.cursor + LOC_COUNT - 1) % LOC_COUNT;
      break;
    case "scroll-down":
      window.cursor = (window.cursor + 1) % LOC_COUNT;
      break;
    // Watch swipes are spatial over the two rows of eight columns: up/down
    // switch between the top row (free cells + foundations) and the cascades
    // keeping the column, left/right move within the row.
    case "swipe-up":
      if (window.cursor >= LOC_CASCADE0) window.cursor -= LOC_CASCADE0;
      break;
    case "swipe-down":
      if (window.cursor < LOC_CASCADE0) window.cursor += LOC_CASCADE0;
      break;
    case "swipe-left":
      if (window.cursor % LOC_CASCADE0 > 0) window.cursor--;
      break;
    case "swipe-right":
      if (window.cursor % LOC_CASCADE0 < LOC_CASCADE0 - 1) window.cursor++;
      break;
    case "click":
      if (window.selected === null) {
        if (locationHasCard(window, window.cursor)) {
          window.selected = window.cursor;
          playSfx(window, SFX_SELECT);
        } else {
          playSfx(window, SFX_ERROR);
        }
      } else if (window.selected === window.cursor) {
        window.selected = null;
      } else {
        performMove(window, window.selected, window.cursor);
      }
      break;
    case "double-click":
      if (window.selected !== null) {
        window.selected = null;
      } else {
        sendToFoundation(window, window.cursor);
      }
      break;
    case "long-press":
      openWindowMenu(window);
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: freecell ignored input");
      return;
  }
  renderAndSubmit(window, frameId);
}

function handleWonInput(window: FreecellWindow, event: InputEvent, frameId: number): void {
  switch (directionalFallback(event).type) {
    case "click":
      newGame(window, false);
      playSfx(window, SFX_NEW_GAME);
      break;
    case "double-click":
      frameTimings.finishFrame(frameId, "discarded: freecell yielded focus");
      post({ type: "yield-focus", windowId: window.windowId });
      return;
    case "long-press":
      openWindowMenu(window);
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: freecell ignored input");
      return;
  }
  renderAndSubmit(window, frameId);
}

function newGame(window: FreecellWindow, keepDeal: boolean): void {
  if (!keepDeal || window.dealOrder.length !== 52) {
    const order = Array.from({ length: 52 }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    window.dealOrder = order;
  }
  window.cascades = Array.from({ length: 8 }, () => []);
  for (let i = 0; i < 52; i++) {
    window.cascades[i % 8]!.push(window.dealOrder[i]!);
  }
  window.cells = [null, null, null, null];
  window.foundations = [null, null, null, null];
  window.undoStack = [];
  window.moves = 0;
  window.cursor = LOC_CASCADE0;
  window.selected = null;
  window.phase = "playing";
}

function snapshot(window: FreecellWindow): Snapshot {
  return {
    cascades: window.cascades.map((cascade) => [...cascade]),
    cells: [...window.cells],
    foundations: [...window.foundations],
    moves: window.moves,
  };
}

function undoMove(window: FreecellWindow): void {
  const previous = window.undoStack.pop();
  if (!previous) return;
  window.cascades = previous.cascades;
  window.cells = previous.cells;
  window.foundations = previous.foundations;
  window.moves = previous.moves;
  window.selected = null;
  playSfx(window, SFX_UNDO);
}

function locationHasCard(window: FreecellWindow, location: number): boolean {
  if (location < LOC_FOUNDATION0) return window.cells[location] !== null;
  if (location < LOC_CASCADE0) return window.foundations[location - LOC_FOUNDATION0] !== null;
  return window.cascades[location - LOC_CASCADE0]!.length > 0;
}

/** True if `card` can go on `onto` in a cascade (descending, alternating color). */
function canStack(card: number, onto: number): boolean {
  return rankOf(onto) === rankOf(card) + 1 && isRed(onto) !== isRed(card);
}

function foundationCanAccept(pileTop: number | null, card: number): boolean {
  if (pileTop === null) return rankOf(card) === 1;
  return suitOf(pileTop) === suitOf(card) && rankOf(card) === rankOf(pileTop) + 1;
}

/** The foundation pile this card can legally go to right now, or -1. */
function foundationIndexFor(window: FreecellWindow, card: number): number {
  for (let i = 0; i < 4; i++) {
    const top = window.foundations[i]!;
    if (top !== null && suitOf(top) === suitOf(card)) {
      return rankOf(card) === rankOf(top) + 1 ? i : -1;
    }
  }
  if (rankOf(card) === 1) {
    return window.foundations.indexOf(null);
  }
  return -1;
}

/** Length of the movable tail run (descending, alternating colors). */
function tailRunLength(cascade: number[]): number {
  let length = Math.min(1, cascade.length);
  while (length < cascade.length && canStack(cascade[cascade.length - length]!, cascade[cascade.length - length - 1]!)) {
    length++;
  }
  return length;
}

/**
 * Supermove capacity: (empty free cells + 1) doubled per empty cascade. A
 * move into an empty cascade can't count that cascade as a waypoint.
 */
function moveCapacity(window: FreecellWindow, excludeCascade: number): number {
  const freeCells = window.cells.filter((cell) => cell === null).length;
  let capacity = freeCells + 1;
  for (let i = 0; i < 8; i++) {
    if (i !== excludeCascade && window.cascades[i]!.length === 0) capacity *= 2;
  }
  return capacity;
}

/** The card a location would give up right now (cascade top), or null. */
function topCardAt(window: FreecellWindow, location: number): number | null {
  if (location < LOC_FOUNDATION0) return window.cells[location]!;
  if (location < LOC_CASCADE0) return window.foundations[location - LOC_FOUNDATION0]!;
  const cascade = window.cascades[location - LOC_CASCADE0]!;
  return cascade.length > 0 ? cascade[cascade.length - 1]! : null;
}

/** Remove the card `topCardAt` reported (single-card sources only). */
function takeCardFrom(window: FreecellWindow, location: number): void {
  if (location < LOC_FOUNDATION0) {
    window.cells[location] = null;
  } else if (location < LOC_CASCADE0) {
    const pile = location - LOC_FOUNDATION0;
    const top = window.foundations[pile]!;
    window.foundations[pile] = rankOf(top!) > 1 ? top! - 4 : null;
  } else {
    window.cascades[location - LOC_CASCADE0]!.pop();
  }
}

/**
 * Attempt a user move between two locations; on success commit it as one
 * undoable step (including any safe auto-plays it unlocks).
 */
function performMove(window: FreecellWindow, src: number, dst: number): void {
  const before = snapshot(window);
  const result = attemptMove(window, src, dst);
  if (!result.moved) {
    playSfx(window, SFX_ERROR);
    return;
  }
  window.undoStack.push(before);
  if (window.undoStack.length > 200) window.undoStack.shift();
  window.moves++;
  window.selected = null;
  playSfx(window, result.toFoundation ? SFX_FOUNDATION : SFX_MOVE);
  autoSafeMoves(window);
  checkWin(window);
}

function attemptMove(window: FreecellWindow, src: number, dst: number): { moved: boolean; toFoundation: boolean } {
  const failed = { moved: false, toFoundation: false };
  const srcIsCascade = src >= LOC_CASCADE0;
  const dstIsCell = dst < LOC_FOUNDATION0;
  const dstIsFoundation = !dstIsCell && dst < LOC_CASCADE0;

  if (dstIsFoundation) {
    if (src >= LOC_FOUNDATION0 && src < LOC_CASCADE0) return failed;
    const card = topCardAt(window, src);
    const pile = dst - LOC_FOUNDATION0;
    if (card === null || !foundationCanAccept(window.foundations[pile]!, card)) return failed;
    takeCardFrom(window, src);
    window.foundations[pile] = card;
    return { moved: true, toFoundation: true };
  }

  if (dstIsCell) {
    if (window.cells[dst] !== null) return failed;
    const card = topCardAt(window, src);
    if (card === null) return failed;
    takeCardFrom(window, src);
    window.cells[dst] = card;
    return { moved: true, toFoundation: false };
  }

  // Destination is a cascade.
  const dstCascade = window.cascades[dst - LOC_CASCADE0]!;
  const dstTop = dstCascade.length > 0 ? dstCascade[dstCascade.length - 1]! : null;

  if (!srcIsCascade) {
    const card = topCardAt(window, src);
    if (card === null) return failed;
    if (dstTop !== null && !canStack(card, dstTop)) return failed;
    takeCardFrom(window, src);
    dstCascade.push(card);
    return { moved: true, toFoundation: false };
  }

  const srcCascade = window.cascades[src - LOC_CASCADE0]!;
  if (srcCascade.length === 0) return failed;
  const capacity = moveCapacity(window, dstTop === null ? dst - LOC_CASCADE0 : -1);
  const maxRun = Math.min(tailRunLength(srcCascade), capacity);
  // Take the longest legal run; onto an empty cascade any run length works.
  for (let n = maxRun; n >= 1; n--) {
    const bottom = srcCascade[srcCascade.length - n]!;
    if (dstTop === null || canStack(bottom, dstTop)) {
      dstCascade.push(...srcCascade.splice(srcCascade.length - n, n));
      return { moved: true, toFoundation: false };
    }
  }
  return failed;
}

/** Double-click convenience: the card at `location` goes to its foundation. */
function sendToFoundation(window: FreecellWindow, location: number): void {
  if (location >= LOC_FOUNDATION0 && location < LOC_CASCADE0) {
    playSfx(window, SFX_ERROR);
    return;
  }
  const card = topCardAt(window, location);
  const pile = card === null ? -1 : foundationIndexFor(window, card);
  if (pile < 0) {
    playSfx(window, SFX_ERROR);
    return;
  }
  performMove(window, location, LOC_FOUNDATION0 + pile);
}

/** Foundation rank per suit (0 while that suit has no pile). */
function foundationRankBySuit(window: FreecellWindow): number[] {
  const ranks = [0, 0, 0, 0];
  for (const top of window.foundations) {
    if (top !== null) ranks[suitOf(top)] = rankOf(top);
  }
  return ranks;
}

/**
 * A card is safe to auto-play when no cascade card could still need it:
 * rank 2 or less, or both opposite-color foundations at rank-1 or higher.
 */
function isSafeAutoPlay(window: FreecellWindow, card: number): boolean {
  const rank = rankOf(card);
  if (rank <= 2) return true;
  const ranks = foundationRankBySuit(window);
  const oppositeMin = isRed(card) ? Math.min(ranks[0]!, ranks[2]!) : Math.min(ranks[1]!, ranks[3]!);
  return oppositeMin >= rank - 1;
}

/** Repeatedly move safe cards (cell or cascade top) to the foundations. */
function autoSafeMoves(window: FreecellWindow): void {
  let moved = true;
  while (moved) {
    moved = false;
    for (let location = 0; location < LOC_COUNT; location++) {
      if (location >= LOC_FOUNDATION0 && location < LOC_CASCADE0) continue;
      const card = topCardAt(window, location);
      if (card === null || !isSafeAutoPlay(window, card)) continue;
      const pile = foundationIndexFor(window, card);
      if (pile < 0) continue;
      takeCardFrom(window, location);
      window.foundations[pile] = card;
      moved = true;
    }
  }
}

function checkWin(window: FreecellWindow): void {
  const done = window.foundations.every((top) => top !== null && rankOf(top) === 13);
  if (!done) return;
  window.phase = "won";
  window.selected = null;
  playSfx(window, SFX_WIN);
}

// ---------------------------------------------------------------------------
// Painting

type Layout = {
  pitch: number;
  marginX: number;
  /** Vertical pixels per buried cascade card (its visible label strip). */
  strip: (cascadeLength: number) => number;
};

function layoutFor(window: FreecellWindow): Layout {
  const pitch = Math.floor((window.viewportWidth - 12) / 8);
  const marginX = Math.floor((window.viewportWidth - (pitch * 8 - (pitch - CARD_W))) / 2);
  const available = window.viewportHeight - CASCADE_Y - 2;
  return {
    pitch,
    marginX,
    strip: (cascadeLength: number) =>
      cascadeLength <= 1 ? 0 : Math.min(16, Math.floor((available - CARD_H) / (cascadeLength - 1))),
  };
}

function paint(window: FreecellWindow): Plane[] {
  if (window.menu?.isOpen()) {
    return window.menu.paint();
  }
  const planes = singlePlane(paintContent(window));
  if (window.phase === "won") {
    // The win box goes on its own plane: card labels are deferred glyphs that
    // render above their own image's raster, so an overlay drawn into the
    // board image could not cover them.
    const overlay = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
    paintWinOverlay(overlay, window);
    planes.push({ image: overlay, x: 0, y: 0 });
  }
  return planes;
}

function paintContent(window: FreecellWindow): GrayImage {
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  const layout = layoutFor(window);
  const colX = (i: number) => layout.marginX + i * layout.pitch;

  // Top row: free cells then foundations, with a divider between the groups.
  for (let i = 0; i < 4; i++) {
    const card = window.cells[i]!;
    if (card === null) {
      image.drawRoundedRect(colX(i), TOP_Y, CARD_W, CARD_H, 70, 4);
    } else {
      paintCard(image, colX(i), TOP_Y, card, window.selected === LOC_CELL0 + i, true);
    }
  }
  image.drawLine(colX(4) - 4, TOP_Y + 4, colX(4) - 4, TOP_Y + CARD_H - 4, 70);
  for (let i = 0; i < 4; i++) {
    const x = colX(4 + i);
    const card = window.foundations[i]!;
    if (card === null) {
      image.drawRoundedRect(x, TOP_Y, CARD_W, CARD_H, 70, 4);
      image.drawText(labelFont, x + Math.round((CARD_W - labelFont.measureText("A")) / 2), TOP_Y + 10, "A", 70);
    } else {
      paintCard(image, x, TOP_Y, card, window.selected === LOC_FOUNDATION0 + i, true);
    }
  }

  for (let i = 0; i < 8; i++) {
    paintCascade(image, window, layout, i);
  }
  paintCursor(image, window, layout);
  // The win overlay is painted onto its own plane by paint(), not here.
  return image;
}

function paintCascade(image: GrayImage, window: FreecellWindow, layout: Layout, index: number): void {
  const x = layout.marginX + index * layout.pitch;
  const cascade = window.cascades[index]!;
  if (cascade.length === 0) {
    image.drawRoundedRect(x, CASCADE_Y, CARD_W, CARD_H, 45, 4);
    return;
  }
  const strip = layout.strip(cascade.length);
  // How many tail cards the pending selection would move (highlighted).
  let highlightFrom = cascade.length;
  if (window.selected === LOC_CASCADE0 + index) {
    const run = Math.min(tailRunLength(cascade), moveCapacity(window, -1));
    highlightFrom = cascade.length - run;
  }
  for (let i = 0; i < cascade.length; i++) {
    paintCard(image, x, CASCADE_Y + i * strip, cascade[i]!, i >= highlightFrom, i === cascade.length - 1);
  }
}

function paintCard(
  image: GrayImage,
  x: number,
  y: number,
  card: number,
  selected: boolean,
  fullyVisible: boolean,
): void {
  const shade = isRed(card) ? RED_SHADE : BLACK_SHADE;
  image.fillRoundedRect(x, y, CARD_W, CARD_H, selected ? 60 : 25, 4);
  image.drawRoundedRect(x, y, CARD_W, CARD_H, selected ? 255 : 160, 4);
  if (selected) image.drawRoundedRect(x + 1, y + 1, CARD_W - 2, CARD_H - 2, 255, 3);
  image.drawText(labelFont, x + 5, y + 2, cardLabel(card), shade);
  if (fullyVisible) {
    image.drawText(mediumFont, x + CARD_W - 18, y + CARD_H - 29, SUIT_CHARS[suitOf(card)]!, shade);
  }
}

/** Bright double outline around the cursor's location, minesweeper-style. */
function paintCursor(image: GrayImage, window: FreecellWindow, layout: Layout): void {
  if (window.phase !== "playing") return;
  let x: number;
  let y: number;
  let height: number;
  if (window.cursor < LOC_CASCADE0) {
    x = layout.marginX + (window.cursor % 8) * layout.pitch;
    y = TOP_Y;
    height = CARD_H;
  } else {
    const index = window.cursor - LOC_CASCADE0;
    const cascade = window.cascades[index]!;
    x = layout.marginX + index * layout.pitch;
    y = CASCADE_Y;
    height = cascade.length === 0 ? CARD_H : (cascade.length - 1) * layout.strip(cascade.length) + CARD_H;
  }
  image.drawRect(x - 3, y - 3, CARD_W + 6, height + 6, 255);
  image.drawRect(x - 2, y - 2, CARD_W + 4, height + 4, 255);
}

function paintWinOverlay(image: GrayImage, window: FreecellWindow): void {
  const width = 320;
  const height = 120;
  const x = Math.round((window.viewportWidth - width) / 2);
  const y = Math.round((window.viewportHeight - height) / 2);
  // Fill 1, not 0: identical after 4bpp quantization, but 0 is transparent
  // when this overlay composites as its own plane over the board.
  image.fillRoundedRect(x, y, width, height, 1, 8);
  image.drawRoundedRect(x, y, width, height, 200, 8);
  drawCenteredIn(image, largeFont, x, width, y + 14, "You win!", 255);
  drawCenteredIn(image, smallFont, x, width, y + 56, `${window.moves} moves`, 170);
  drawCenteredIn(image, smallFont, x, width, y + 80, `${GESTURE_CLICK} new game   ${GESTURE_DOUBLE_CLICK} leave`, 150);
  drawCenteredIn(image, smallFont, x, width, y + 98, `${GESTURE_LONG_PRESS} menu`, 150);
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

function renderAndSubmit(window: FreecellWindow, inputFrameId: number): void {
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${window.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => paint(window)),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = planesFingerprint(planes);
    if (fingerprint === window.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: freecell content unchanged");
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
    frameTimings.finishFrame(frameId, "discarded: freecell render failed");
    console.error(`freecell worker render failed: ${error}`);
  }
}
