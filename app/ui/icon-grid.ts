import { DrawExpression as E } from "../graphics/draw-expression";
import { DrawOp, type DisplayList, type ListCall, type ListClip } from "../graphics/display-list";
import { encodeReplayDraws } from "../graphics/glyph-wire";
import { GrayImage, type UiFont } from "../graphics/image";
import { slidingCoordinate } from "../graphics/menu-scroll-list";
import { getDefaultSmallFont } from "../graphics/ui-fonts";
import { truncateText } from "../graphics/textwrap";
import { clamp } from "../util/numeric-util";
import { isWatchInput, type InputEvent } from "./gestures";
import type { LayerContext } from "./layers";
import { drawListScrollbar, drawSelectionHighlight, scrollToKeepSelectionVisible } from "./menu";
import { BOUNCE_FRACTION, MAX_BOUNCE, MENU_HIGHLIGHT_FILL, MENU_HIGHLIGHT_STROKE, type MenuBox } from "./menu-core";
import { MenuHighlightMotion, type MenuHighlightAnimation } from "./menu-highlight-motion";
import { MenuScrollMotion, scrollOffsetExpression, type MenuScrollAnimation } from "./menu-scroll-motion";
import { iconGridMinRowHeight } from "./metrics";
import { shell } from "./shell/shell";

/** Size of the square each grid cell reserves for its icon; render icons at this size. */
export const ICON_GRID_ICON_SIZE = 44;
const LABEL_GAP = 2;
const DEFAULT_COLUMNS = 5;
const DEFAULT_LABEL_VALUE = 210;
/** Wide rows: text inset from the grid's left and right edges. */
const WIDE_TEXT_X = 20;
/** The scrollbar's columns at the right edge, which animations leave alone. */
const SCROLLBAR_GUTTER = 5;

export type IconGridCell = {
  label: string;
  /**
   * Icon for a grid cell (ignored for wide rows). Drawn as a deferred image,
   * so it must be long-lived and never mutated: a memoized render, not a
   * scratch buffer. Icons smaller than ICON_GRID_ICON_SIZE are centered in
   * the square.
   */
  icon?: GrayImage | null;
  /** Label brightness. Default 210. */
  labelValue?: number;
};

export type IconGridOptions<T> = {
  /** The items to show, fetched fresh at every paint, input, and selection call. */
  items: () => readonly T[];
  /** Columns per grid row. Default 5. */
  columns?: number;
  /** How to draw an item. `selected` is true while it alone is selected (item mode, or a wide row). */
  describe: (item: T, selected: boolean) => IconGridCell;
  /**
   * Items drawn as a full-width text row of their own (a notice or prompt)
   * instead of a grid cell. Selection treats such a row as one item.
   */
  isWide?: (item: T) => boolean;
  /**
   * Open an item. Return true when this left the grid (e.g. launched an app
   * or yielded focus) rather than navigating within it; see onBack.
   */
  onActivate: (item: T, index: number, ctx: LayerContext) => boolean | void | Promise<boolean | void>;
  /**
   * Back out one level: a ring double-click in row mode, or the watch's back
   * or left swipe from the first column. Return true when this left the grid.
   *
   * After either callback the grid settles its mode: leaving puts it back in
   * row mode, so a ring user returning finds it as they left it; staying
   * with watch input keeps single-item selection (which the watch scheme
   * always uses), even if the host reset the selection while navigating.
   */
  onBack: (ctx: LayerContext) => boolean | void;
  /** Draw a scrollbar at the right edge when rows overflow. Default false. */
  scrollbar?: boolean;
};

type GridRow<T> =
  | { kind: "wide"; item: T; firstIndex: number }
  | { kind: "cells"; items: T[]; firstIndex: number };

type GridMode = "row" | "item";

type GridLayout = { box: MenuBox; rowH: number; colW: number };

/**
 * The selection highlight in image coordinates. `key` names what is
 * selected for highlight motion: a flat item index, or -1 - row for a
 * row-mode band.
 */
type Highlight = { key: number; x: number; y: number; width: number; height: number; radius: number };

/**
 * An icon grid: items laid out as labeled icons in fixed-width columns, with
 * optional full-width text rows (see isWide). Like Menu, it is independent of
 * the Layer stack: the host paints it into a rect of its own image and
 * forwards input, and keeps the rest (header, what items mean, where back
 * goes).
 *
 * Rows are exactly as tall as their content (icon, label line, breathing
 * room), so they grow smoothly with the font; they never stretch to fill the
 * box, which would make the padding jump whenever a font step changed how
 * many rows fit. Space left below the last full row shows the top of the
 * next row, cut off at the box's edge, as a hint that there is more to scroll to.
 *
 * Ring input navigates on two levels, halving the scrolls to reach an item:
 * in row mode scroll picks a row and a click drops into item mode on it,
 * defaulting to the middle column; in item mode scroll traverses items
 * linearly (continuing onto adjacent rows) and a click opens the item.
 * Double-click backs out: item mode to row mode, then onBack. A wide row is
 * opened by a click in either mode. Watch input skips row mode and moves one
 * cell at a time in four directions: up/down (and the crown) between rows
 * keeping the column, right/left within the row, and left from the first
 * column (or a wide row) backs out, as does the watch's back.
 *
 * Navigation animates on the glasses as menus do: the highlight slides to
 * the new selection, rows scroll into view, and moving past an end bounces.
 * A grid is too big for Menu's pre-rendered strip, so the animation is a
 * display list that clears the grid and redraws it from the rows' glyph and
 * icon draws, offset by the animated scroll and clipped to the box
 * (revision 35 firmware). Its last frame equals the static paint. When a
 * row can't be replayed that way (a label outside ASCII, say), it snaps.
 */
export class IconGrid<T> {
  private mode: GridMode = "row";
  private selectedRow = 0;
  private selectedCol = 0;
  private scrollRow = 0;
  /** Geometry of the last paint, for hitTest and bounces: what the phone mirror showed. */
  private layout: GridLayout | null = null;
  private readonly highlightMotion = new MenuHighlightMotion();
  private readonly scrollMotion = new MenuScrollMotion();

  constructor(private readonly options: IconGridOptions<T>) {}

  private get columns(): number {
    return this.options.columns ?? DEFAULT_COLUMNS;
  }

  /** Back to row mode on the first row, scrolled to the top (e.g. after entering a directory). */
  resetSelection(): void {
    this.mode = "row";
    this.selectedRow = 0;
    this.selectedCol = 0;
    this.scrollRow = 0;
  }

  /** Drop from item mode to row mode, keeping the selected row. */
  enterRowMode(): void {
    this.mode = "row";
  }

  /**
   * Move the selection onto the item at a flat index (e.g. the directory
   * just left), leaving the mode and scroll position alone; the next paint
   * scrolls the minimum needed to show it.
   */
  selectIndex(index: number): void {
    const rows = this.buildRows();
    const rowIndex = rows.findIndex((row) => index >= row.firstIndex && index < row.firstIndex + rowLength(row));
    if (rowIndex < 0) return;
    this.selectedRow = rowIndex;
    this.selectedCol = index - rows[rowIndex]!.firstIndex;
  }

  /**
   * Flat index of the item under the selection. In row mode on a grid row
   * that is the cell at the remembered column, though no single item is
   * selected yet (see selectedItem). Null when there are no items.
   */
  get cursorIndex(): number | null {
    const row = this.currentRow();
    if (!row) return null;
    return row.kind === "wide" ? row.firstIndex : row.firstIndex + clamp(this.selectedCol, 0, row.items.length - 1);
  }

  /** The single selected item: a wide row, or a cell in item mode. Null in row mode on a grid row. */
  get selectedItem(): T | null {
    const row = this.currentRow();
    if (!row) return null;
    if (row.kind === "wide") return row.item;
    if (this.mode !== "item") return null;
    return row.items[clamp(this.selectedCol, 0, row.items.length - 1)] ?? null;
  }

  /**
   * Focus arriving from the watch goes straight to item selection: the watch
   * has left/right swipes, so it never needs row mode, and starting there
   * would paint a row band its scheme can't produce. Any other source enters
   * in row mode.
   */
  onFocus(lastInput: InputEvent | null): void {
    if (lastInput && isWatchInput(lastInput)) {
      this.mode = "item";
      this.clampSelection(this.buildRows());
    } else {
      this.mode = "row";
    }
  }

  paint(image: GrayImage, box: MenuBox, focused: boolean): void {
    const font = getDefaultSmallFont();
    const rows = this.buildRows();
    this.clampSelection(rows);
    const rowH = iconGridMinRowHeight(font, ICON_GRID_ICON_SIZE, LABEL_GAP);
    const fullRows = Math.max(1, Math.floor(box.height / rowH));
    // Scroll to keep the selected row among the fully-visible rows.
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, this.selectedRow, fullRows, rows.length);
    const layout: GridLayout = { box, rowH, colW: box.width / this.columns };
    this.layout = layout;

    const highlight = this.highlight(rows, layout, font, focused);
    const bottom = box.y + box.height;
    for (let rowIndex = this.scrollRow; rowIndex < rows.length; rowIndex++) {
      const y = box.y + (rowIndex - this.scrollRow) * rowH;
      if (y >= bottom) break;
      if (highlight && rowIndex === this.selectedRow) {
        drawSelectionHighlight(image, highlight.x, highlight.y, highlight.width, highlight.height, focused, highlight.radius);
      }
      this.drawRow(image, rows[rowIndex]!, rowIndex, box.x, y, layout, font, bottom);
    }

    const scrollbar = !!this.options.scrollbar && rows.length > fullRows;
    if (scrollbar) {
      drawListScrollbar(image, box.x + box.width - SCROLLBAR_GUTTER, box.y, box.height, this.scrollRow, fullRows, rows.length);
    }
    this.paintMotion(image, rows, layout, font, focused, highlight, scrollbar);
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (isWatchInput(event)) {
      await this.handleWatchInput(event, ctx);
    } else {
      await this.handleRingInput(event, ctx);
    }
  }

  /**
   * A touch on the phone's mirror: the item under it becomes the selection
   * and opens, as a ring click on it would. Uses the last paint's geometry,
   * so it lands on what the mirror showed.
   */
  async hitTest(x: number, y: number, ctx: LayerContext): Promise<boolean> {
    if (!this.layout) return false;
    const { box, rowH, colW } = this.layout;
    if (x < box.x || x >= box.x + box.width || y < box.y || y >= box.y + box.height) return false;
    const rowIndex = this.scrollRow + Math.floor((y - box.y) / rowH);
    const row = this.buildRows()[rowIndex];
    if (!row) return false;
    if (row.kind === "cells") {
      const col = Math.floor((x - box.x) / colW);
      if (col >= row.items.length) return false;
      this.selectedCol = col;
    }
    this.selectedRow = rowIndex;
    this.mode = "item";
    await this.activateSelected(false, ctx);
    return true;
  }

  /**
   * The highlight for the current selection: a row band, a single cell in
   * item mode, or a box around a wide row's text. While defocused with the
   * watch as the last-used source, the cell outline is shown even in row
   * mode: watch focus enters item mode directly (see onFocus), so the
   * outline previews the cell a click would land on rather than a row band
   * the watch scheme never shows. Every cell's box has the same width, so
   * the highlight can slide between any two.
   */
  private highlight(rows: readonly GridRow<T>[], layout: GridLayout, font: UiFont, focused: boolean): Highlight | null {
    const row = rows[this.selectedRow];
    if (!row) return null;
    const { box, rowH, colW } = layout;
    const y = box.y + (this.selectedRow - this.scrollRow) * rowH;
    if (row.kind === "wide") {
      const textY = y + wideTextOffset(rowH, font);
      return { key: row.firstIndex, x: box.x + WIDE_TEXT_X - 6, y: textY - 2,
        width: box.width - 2 * WIDE_TEXT_X + 12, height: font.lineHeight + 4, radius: 4 };
    }
    if (this.mode === "item" || (!focused && shell.lastInputWasWatch())) {
      return { key: row.firstIndex + this.selectedCol, x: Math.round(box.x + this.selectedCol * colW) + 6, y: y + 2,
        width: Math.round(colW) - 12, height: rowH - 4, radius: 6 };
    }
    return { key: -1 - this.selectedRow, x: box.x + 4, y: y + 2, width: box.width - 8, height: rowH - 4, radius: 6 };
  }

  /**
   * Draw one row's icons and labels (not the highlight) with its top at y.
   * A row crossing `clipBottom` goes through a scratch image cut off there,
   * so the static peeking row matches an animation's clipped frames.
   */
  private drawRow(target: GrayImage, row: GridRow<T>, rowIndex: number, x0: number, y: number,
      layout: GridLayout, font: UiFont, clipBottom?: number): void {
    const { rowH, colW } = layout;
    if (clipBottom !== undefined && y + rowH > clipBottom) {
      const scratch = new GrayImage(layout.box.width, rowH);
      this.drawRow(scratch, row, rowIndex, 0, 0, layout, font);
      target.bitBlt(scratch.withDrawsBaked(), x0, y, { height: clipBottom - y, transparentZero: true });
      return;
    }
    const rowSelected = rowIndex === this.selectedRow;
    if (row.kind === "wide") {
      const { label, labelValue = DEFAULT_LABEL_VALUE } = this.options.describe(row.item, rowSelected);
      const width = layout.box.width - 2 * WIDE_TEXT_X;
      target.drawText(font, x0 + WIDE_TEXT_X, y + wideTextOffset(rowH, font), truncateText(font, label, width), labelValue);
      return;
    }
    const blockTop = y + Math.max(2, (rowH - ICON_GRID_ICON_SIZE - font.lineHeight - LABEL_GAP) / 2);
    for (let col = 0; col < row.items.length; col++) {
      const cell = this.options.describe(row.items[col]!, rowSelected && this.mode === "item" && col === this.selectedCol);
      const centerX = x0 + col * colW + colW / 2;
      if (cell.icon) {
        const icon = cell.icon;
        target.drawImage(icon, Math.round(centerX - icon.width / 2),
          Math.round(blockTop + Math.max(0, (ICON_GRID_ICON_SIZE - icon.height) / 2)));
      }
      const label = truncateText(font, cell.label, colW - 8);
      target.drawText(font, Math.round(centerX - font.measureText(label) / 2), Math.round(blockTop + ICON_GRID_ICON_SIZE + LABEL_GAP),
        label, cell.labelValue ?? DEFAULT_LABEL_VALUE);
    }
  }

  /**
   * Track this paint's scroll offset and highlight, and while either is
   * moving, retain the display list that animates them over the static paint.
   */
  private paintMotion(image: GrayImage, rows: readonly GridRow<T>[], layout: GridLayout, font: UiFont,
      focused: boolean, highlight: Highlight | null, scrollbar: boolean): void {
    const now = Date.now();
    const scrollOffset = this.scrollRow * layout.rowH;
    const scroll = this.scrollMotion.paint(scrollOffset, layout.box, now);
    const slide = highlight
      ? this.highlightMotion.paint(highlight.key, scrollOffset, highlight.x, highlight.y, highlight.width, highlight.height, now, !!scroll)
      : undefined;
    if (!scroll && !slide) return;
    const { box } = layout;
    const clip: ListClip = { x: 0, y: 0, width: box.width - (scrollbar ? SCROLLBAR_GUTTER : 0), height: box.height };
    const list = this.motionList(rows, layout, font, focused, highlight, clip, scroll, slide);
    if (!list) {
      this.scrollMotion.cancel();
      this.highlightMotion.cancel();
      return;
    }
    image.drawDisplayList(list, box.x, box.y, clip.width, clip.height);
  }

  /**
   * The animation, in box coordinates: clear the box, draw the highlight
   * (sliding, and carried along by a bounce), then replay every row visible
   * at any point of the scroll, offset by it. Null when those rows hold
   * anything the glasses can't replay.
   */
  private motionList(rows: readonly GridRow<T>[], layout: GridLayout, font: UiFont, focused: boolean,
      highlight: Highlight | null, clip: ListClip, scroll: MenuScrollAnimation | undefined,
      slide: MenuHighlightAnimation | undefined): DisplayList | null {
    const { box, rowH } = layout;
    const scrollOffset = this.scrollRow * rowH;
    const offsets = scroll ? [scroll.from, scroll.to, scroll.peak ?? scroll.to] : [scrollOffset];
    const firstRow = Math.max(0, Math.floor(Math.min(...offsets) / rowH));
    const lastRow = Math.min(rows.length, Math.ceil((Math.max(...offsets) + box.height) / rowH));
    const content = new GrayImage(box.width, Math.max(1, (lastRow - firstRow) * rowH));
    for (let rowIndex = firstRow; rowIndex < lastRow; rowIndex++) {
      this.drawRow(content, rows[rowIndex]!, rowIndex, 0, (rowIndex - firstRow) * rowH, layout, font);
    }
    if (content.pixels.some((value) => value !== 0)) return null;
    const replay = encodeReplayDraws(content.draws);
    if (!replay) return null;

    // One timeline: the newer motion's. The other, if any, continues on it with a negative delay.
    const timeline = scroll && (!slide || scroll.startedAt >= slide.startedAt) ? scroll : slide!;
    const offset = scroll ? scrollOffsetExpression(scroll, timeline.startedAt) : E.i32(scrollOffset);
    const calls: ListCall[] = [{ op: DrawOp.CLEAR, color: 0, clip }];
    if (highlight) {
      let y = slidingCoordinate(highlight.y - box.y, slide?.dy ?? 0, slide, timeline.startedAt);
      // A bounce carries the highlight with its row.
      if (scroll?.peak !== undefined) y = y.add(E.i32(scroll.to)).sub(offset);
      const q = (gray: number) => Math.min(15, (gray + 8) >> 4);
      calls.push({ op: DrawOp.ROUNDED_RECT, x: slidingCoordinate(highlight.x - box.x, slide?.dx ?? 0, slide, timeline.startedAt), y,
        width: highlight.width, height: highlight.height, radius: highlight.radius,
        background: focused ? q(MENU_HIGHLIGHT_FILL) : 0, border: q(MENU_HIGHLIGHT_STROKE), clip });
    }
    // Without a scroll the rows stay put; a literal keeps every compiled call small.
    const rowsY = scroll ? E.i32(firstRow * rowH).sub(offset) : (firstRow - this.scrollRow) * rowH;
    calls.push({ op: DrawOp.DRAWS, x: 0, y: rowsY, records: replay.records, count: replay.count, source: content, clip });
    return { resources: [], timeline: { token: timeline.token, startedAt: timeline.startedAt }, calls };
  }

  private async handleRingInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    const rows = this.buildRows();
    this.clampSelection(rows);
    const row = rows[this.selectedRow];
    const from = this.selectionKey(rows);
    switch (event.type) {
      case "scroll-up":
      case "scroll-down": {
        const delta = event.type === "scroll-down" ? 1 : -1;
        if (this.mode === "row") {
          const next = this.selectedRow + delta;
          if (next < 0 || next >= rows.length) {
            this.bounce(delta);
            return;
          }
          this.selectedRow = next;
          this.moved(from);
          return;
        }
        // Past a row's edge, item selection continues onto the adjacent row
        // (a wide row counts as a single item), stopping at the grid's ends.
        if (row?.kind === "cells") {
          const next = this.selectedCol + delta;
          if (next >= 0 && next < row.items.length) {
            this.selectedCol = next;
            this.moved(from);
            return;
          }
        }
        const adjacent = rows[this.selectedRow + delta];
        if (!adjacent) {
          this.bounce(delta);
          return;
        }
        this.selectedRow += delta;
        if (adjacent.kind === "cells") {
          this.selectedCol = delta > 0 ? 0 : adjacent.items.length - 1;
        }
        this.moved(from);
        return;
      }
      case "click":
        if (!row) return;
        if (row.kind === "cells" && this.mode === "row") {
          this.mode = "item";
          this.selectedCol = Math.min(Math.floor(this.columns / 2), row.items.length - 1);
          return;
        }
        await this.activateSelected(false, ctx);
        return;
      case "double-click":
        if (this.mode === "item") {
          this.mode = "row";
        } else {
          this.settleAfter(this.options.onBack(ctx) === true, false);
        }
        return;
      default:
        return;
    }
  }

  private async handleWatchInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    const rows = this.buildRows();
    this.mode = "item";
    this.clampSelection(rows);
    const row = rows[this.selectedRow];
    const from = this.selectionKey(rows);
    const back = () => this.settleAfter(this.options.onBack(ctx) === true, true);
    switch (event.type) {
      case "swipe-up":
      case "swipe-down":
      case "scroll-up":
      case "scroll-down": {
        const delta = event.type === "swipe-down" || event.type === "scroll-down" ? 1 : -1;
        const next = this.selectedRow + delta;
        if (next < 0 || next >= rows.length) {
          this.bounce(delta);
          return;
        }
        this.selectedRow = next;
        // Keep the column; a shorter row (or a wide one) clamps it.
        this.clampSelection(rows);
        this.moved(from);
        return;
      }
      case "swipe-right":
        if (row?.kind === "cells" && this.selectedCol + 1 < row.items.length) {
          this.selectedCol++;
          this.moved(from);
        }
        return;
      case "swipe-left":
        if (row?.kind === "cells" && this.selectedCol > 0) {
          this.selectedCol--;
          this.moved(from);
        } else {
          back();
        }
        return;
      case "click":
        await this.activateSelected(true, ctx);
        return;
      case "double-click":
        back();
        return;
      default:
        return;
    }
  }

  /** The highlight key (see Highlight) of the selection while focused. */
  private selectionKey(rows: readonly GridRow<T>[]): number | null {
    const row = rows[this.selectedRow];
    if (!row) return null;
    if (row.kind === "wide") return row.firstIndex;
    return this.mode === "item" ? row.firstIndex + this.selectedCol : -1 - this.selectedRow;
  }

  /** The selection just moved by navigation, from `from`: the next paint animates the change. */
  private moved(from: number | null): void {
    if (from !== null) this.highlightMotion.navigate(from, false);
    this.scrollMotion.navigate(false);
  }

  /** Navigation past an end: overshoot a little and come back, as menus do. */
  private bounce(delta: -1 | 1): void {
    const rowH = this.layout?.rowH;
    if (!rowH) return;
    this.scrollMotion.bounce(delta * Math.min(MAX_BOUNCE, Math.round(rowH * BOUNCE_FRACTION)));
  }

  private async activateSelected(watch: boolean, ctx: LayerContext): Promise<void> {
    const index = this.cursorIndex;
    if (index === null) return;
    const item = this.options.items()[index];
    if (item === undefined) return;
    this.settleAfter((await this.options.onActivate(item, index, ctx)) === true, watch);
  }

  /** The mode rule after a host callback; see IconGridOptions.onBack. */
  private settleAfter(left: boolean, watch: boolean): void {
    if (left) {
      this.mode = "row";
    } else if (watch) {
      this.mode = "item";
      this.clampSelection(this.buildRows());
    }
  }

  private currentRow(): GridRow<T> | undefined {
    const rows = this.buildRows();
    return rows[clamp(this.selectedRow, 0, Math.max(0, rows.length - 1))];
  }

  private clampSelection(rows: readonly GridRow<T>[]): void {
    this.selectedRow = clamp(this.selectedRow, 0, Math.max(0, rows.length - 1));
    const row = rows[this.selectedRow];
    this.selectedCol = row?.kind === "cells" ? clamp(this.selectedCol, 0, row.items.length - 1) : 0;
  }

  /** Wide items get a row of their own; runs of other items are chunked into rows of `columns`. */
  private buildRows(): GridRow<T>[] {
    const items = this.options.items();
    const isWide = this.options.isWide;
    const rows: GridRow<T>[] = [];
    let cells: Extract<GridRow<T>, { kind: "cells" }> | null = null;
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      if (isWide?.(item)) {
        rows.push({ kind: "wide", item, firstIndex: index });
        cells = null;
        continue;
      }
      if (!cells || cells.items.length >= this.columns) {
        cells = { kind: "cells", items: [], firstIndex: index };
        rows.push(cells);
      }
      cells.items.push(item);
    }
    return rows;
  }
}

function rowLength<T>(row: GridRow<T>): number {
  return row.kind === "wide" ? 1 : row.items.length;
}

/** A wide row's text top, relative to the row's top. */
function wideTextOffset(rowH: number, font: UiFont): number {
  return ((rowH - font.lineHeight) / 2) | 0;
}
