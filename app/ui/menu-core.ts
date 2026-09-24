import { GrayImage } from "../graphics/image";
import { menuScrollList, type MenuScrollHighlight } from "../graphics/menu-scroll-list";
import type { InputEvent } from "./gestures";
import { MenuHighlightMotion } from "./menu-highlight-motion";
import { MenuScrollMotion, type MenuScrollAnimation } from "./menu-scroll-motion";

/** Selected-row fill while the menu owns input; the outline alone marks an unfocused menu's selection. */
export const MENU_HIGHLIGHT_FILL = 15;
export const MENU_HIGHLIGHT_STROKE = 45;
const SCROLLBAR_TRACK_VALUE = 30;
const SCROLLBAR_THUMB_VALUE = 120;
const SCROLLBAR_WIDTH = 3;
const SCROLLBAR_MIN_THUMB = 8;
/** Largest packed scroll strip, in bytes: the firmware's per-resource limit. */
const MAX_SCROLL_STRIP_BYTES = 65536;

/** A rectangle in image coordinates. */
export type MenuBox = { x: number; y: number; width: number; height: number };

export type MenuDrawArgs<T> = {
  /**
   * Draw into this image, inside the (x, y, width, height) rect. For the
   * selected row this is a scratch image exactly the rect's size (so x and y
   * are 0), replayed over the highlight. While a scroll animates, rows are
   * also drawn into a strip image covering both viewports. Never draw
   * relative to image.width or image.height, and never outside the rect.
   */
  image: GrayImage;
  item: T;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
  /** Whether the menu owns input right now: the `focused` flag the host passed to paint. */
  focused: boolean;
};

export type MenuHighlightStyle = {
  /** Corner radius of the selection box. Default 8. */
  radius?: number;
  /** Stereo depth of the selection box. Default 0. */
  depth?: number;
};

export type MenuOptions<T> = {
  items?: readonly T[];
  /** Initial selection. Default: the first selectable item. */
  selectedIndex?: number | null;
  /** Row pitch in pixels (including rowGap) for an item laid out at this width. */
  getHeight: (item: T, width: number) => number;
  /** Default: every item is selectable. Non-selectable items (group labels) are skipped by navigation. */
  isSelectable?: (item: T) => boolean;
  draw: (args: MenuDrawArgs<T>) => void;
  /** Called by activate() / a click with the selected item. */
  onSelect?: (item: T, index: number) => void | Promise<void>;
  /**
   * Whether scrolling past either end wraps to the other. When false the
   * selection stays put and onExitTop / onExitBottom is called instead.
   */
  wrap?: boolean;
  onExitTop?: () => void;
  onExitBottom?: () => void;
  /** Pixels between consecutive rows, excluded from each row's drawable box and highlight. Default 0. */
  rowGap?: number;
  /** Selection box style, or false to draw no highlight (the draw callback shows the selection itself). */
  highlight?: MenuHighlightStyle | false;
};

type MenuLayout = { tops: number[]; heights: number[]; total: number };

/**
 * A vertical list with one selected row: the menu proper, independent of the
 * Layer stack. A host paints it into a rect of its own image and forwards
 * scroll / click events while the menu has focus; the host keeps the rest
 * (title, box, focus between several menus, back navigation).
 *
 * Rows may vary in height and some may be unselectable; navigation skips
 * those. Scrolling is pixel-based: the viewport moves the minimum needed to
 * keep the selection and its neighbors fully visible (just the selection
 * when they don't all fit), then aligns to a row top so the list never
 * starts with a partially visible row. Rows that don't fully fit at the
 * bottom are not drawn.
 *
 * Navigation that scrolls (without wrapping) animates on the glasses: the
 * rows visible before and after are drawn into one strip, and a display list
 * slides a viewport-sized copy of it while the highlight moves on the same
 * timeline. When the strip would be too large or the menu doesn't fit the
 * assumptions below (see scrollStrip), the scroll snaps instead.
 */
export class Menu<T> {
  private itemList: readonly T[];
  private selected: number | null;
  /**
   * The caller asked for no selection. Otherwise a null selection only means
   * nothing was selectable, and the first selectable item is chosen as soon
   * as one exists (a menu created empty and filled later starts on it).
   */
  private deselected: boolean;
  private scrollY = 0;
  private lastBox: MenuBox | null = null;
  private readonly motion = new MenuHighlightMotion();
  private readonly scrollMotion = new MenuScrollMotion();

  constructor(private readonly options: MenuOptions<T>) {
    this.itemList = options.items ?? [];
    this.deselected = options.selectedIndex === null;
    this.selected = this.settle(options.selectedIndex ?? null);
  }

  get items(): readonly T[] {
    return this.itemList;
  }

  get selectedIndex(): number | null {
    this.reconcile();
    return this.selected;
  }

  get selectedItem(): T | null {
    const index = this.selectedIndex;
    return index === null ? null : this.itemList[index]!;
  }

  /** Content offset of the viewport's top edge, in pixels. */
  get scrollTop(): number {
    return this.scrollY;
  }

  /** Move the viewport's top edge; the next paint clamps it and scrolls the selection back into view. */
  set scrollTop(value: number) {
    this.scrollY = Math.max(0, value | 0);
  }

  /** True when the content did not fit the box given to the last paint. */
  get overflows(): boolean {
    if (!this.lastBox) return false;
    return this.layout(this.lastBox.width).total > this.lastBox.height;
  }

  /**
   * Replace the items. `selectedIndex` names the new selection (null for
   * none); left out, the selection stays at the same index, clamped into
   * range, or lands on the first selectable item if there was none. The
   * viewport keeps the selected row at the same on-screen position when it can.
   */
  setItems(items: readonly T[], selectedIndex?: number | null): void {
    const width = this.lastBox?.width;
    const before = this.selected !== null && width !== undefined
      ? this.layout(width).tops[this.selected]! - this.scrollY
      : null;
    this.itemList = items;
    if (selectedIndex !== undefined) this.deselected = selectedIndex === null;
    this.selected = this.settle(selectedIndex === undefined ? this.selected : selectedIndex);
    if (before !== null && this.selected !== null && width !== undefined) {
      this.scrollY = Math.max(0, this.layout(width).tops[this.selected]! - before);
    }
  }

  /**
   * Move the selection; a non-selectable or out-of-range index lands on the
   * nearest selectable one. null clears it until the user scrolls or a
   * number is selected.
   */
  select(index: number | null): void {
    this.deselected = index === null;
    this.selected = this.settle(index);
  }

  /** Step the selection by one selectable row; handles wrap and the exit callbacks. */
  moveSelection(delta: -1 | 1): void {
    this.reconcile();
    const from = this.selected;
    const next = this.nextSelectable(from, delta);
    if (next !== null) {
      if (from !== null) this.motion.navigate(from, false);
      this.scrollMotion.navigate(false);
      this.selected = next;
      this.deselected = false;
      return;
    }
    if (from === null && this.scrollContent(delta)) return;
    if (this.options.wrap) {
      const wrapped = this.nextSelectable(null, delta);
      if (wrapped !== null && wrapped !== from) {
        if (from !== null) this.motion.navigate(from, true);
        this.scrollMotion.navigate(true);
        this.selected = wrapped;
        this.deselected = false;
      } else if (from === null && this.lastBox) {
        this.scrollY = delta > 0 ? 0 : this.maxScroll(this.layout(this.lastBox.width), this.lastBox.height);
      }
      return;
    }
    if (delta > 0) this.options.onExitBottom?.();
    else this.options.onExitTop?.();
  }

  /** Invoke onSelect for the selected item. Returns false when nothing is selected. */
  async activate(): Promise<boolean> {
    this.reconcile();
    if (this.selected === null) return false;
    await this.options.onSelect?.(this.itemList[this.selected]!, this.selected);
    return true;
  }

  /** Handle scroll-up, scroll-down and click. Returns false for any other event, or a click with nothing selected. */
  async handleInput(event: InputEvent): Promise<boolean> {
    switch (event.type) {
      case "scroll-up":
        this.moveSelection(-1);
        return true;
      case "scroll-down":
        this.moveSelection(1);
        return true;
      case "click":
        return this.activate();
      default:
        return false;
    }
  }

  /** The selectable item under image-coordinate y in the last painted box, for touch/mirror input. */
  indexAt(y: number): number | null {
    const box = this.lastBox;
    if (!box || y < box.y || y >= box.y + box.height) return null;
    const layout = this.layout(box.width);
    const contentY = y - box.y + this.scrollY;
    for (let index = 0; index < this.itemList.length; index++) {
      if (contentY >= layout.tops[index]! && contentY < layout.tops[index]! + layout.heights[index]!) {
        return this.isSelectable(index) ? index : null;
      }
    }
    return null;
  }

  paint(image: GrayImage, box: MenuBox, focused: boolean): void {
    this.lastBox = box;
    this.reconcile();
    const layout = this.layout(box.width);
    this.ensureVisible(layout, box.height);
    const now = Date.now();
    const scroll = this.scrollMotion.paint(this.scrollY, box, now);
    const strip = scroll ? this.scrollStrip(image, layout, box, focused, scroll) : null;
    if (scroll && !strip) this.scrollMotion.cancel();
    const gap = this.options.rowGap ?? 0;
    const highlight = this.options.highlight;
    let scrollHighlight: MenuScrollHighlight | undefined;
    for (let index = 0; index < this.itemList.length; index++) {
      const top = layout.tops[index]! - this.scrollY;
      const height = layout.heights[index]! - gap;
      const selected = index === this.selected;
      if (top < 0 || top >= box.height) continue;
      // Rows cut off by the bottom edge are not drawn, except a selected row
      // taller than the box, which has nowhere better to be.
      if (top + height > box.height && !selected) continue;
      const rowY = box.y + top;
      const item = this.itemList[index]!;
      if (selected && highlight !== false) {
        const animation = this.motion.paint(index, this.scrollY, box.x, rowY, box.width, height, now, !!strip);
        const background = focused ? MENU_HIGHLIGHT_FILL : 0;
        if (strip) {
          // The strip already holds this row's content; only the box is drawn over it.
          scrollHighlight = { y: top, width: box.width, height, radius: highlight?.radius ?? 8,
            background, border: MENU_HIGHLIGHT_STROKE, animation };
          continue;
        }
        const row = new GrayImage(box.width, height, 0);
        this.options.draw({ image: row, item, index, x: 0, y: 0, width: box.width, height, selected, focused });
        image.drawMenuSelection(row, box.x, rowY, background, MENU_HIGHLIGHT_STROKE,
          highlight?.radius ?? 8, highlight?.depth ?? 0, animation);
      } else {
        this.options.draw({ image, item, index, x: box.x, y: rowY, width: box.width, height, selected, focused });
      }
    }
    // The rows painted above stay underneath: once the animation ends, the
    // strip's final frame and the static paint are pixel-identical.
    if (strip && scroll) {
      image.drawDisplayList(menuScrollList(strip.image, strip.x, strip.top, box.height, scroll, scrollHighlight),
        box.x, box.y, box.width, box.height, 0);
    }
  }

  /** Draw a vertical scrollbar for the last painted box (no-op unless the content overflows it). */
  drawScrollbar(image: GrayImage, x: number, y: number, height: number): void {
    const box = this.lastBox;
    if (!box) return;
    const layout = this.layout(box.width);
    if (layout.total <= box.height) return;
    const maxScroll = this.maxScroll(layout, box.height);
    const thumbHeight = Math.max(SCROLLBAR_MIN_THUMB, (height * box.height / layout.total) | 0);
    const fraction = Math.min(1, Math.max(0, this.scrollY) / maxScroll);
    image.fillRect(x, y, SCROLLBAR_WIDTH, height, SCROLLBAR_TRACK_VALUE);
    image.fillRect(x, y + (((height - thumbHeight) * fraction) | 0), SCROLLBAR_WIDTH, thumbHeight, SCROLLBAR_THUMB_VALUE);
  }

  /**
   * Render every row visible at either end of the scroll into one strip, or
   * return null to snap. Its final frame must match the static paint, so
   * rows the static paint hides (partial ones at the bottom) are left out of
   * the part the new viewport shows. The strip copy is opaque, so this also
   * requires a black background under the menu, a selected row that fits,
   * and a highlight at the menu's own depth.
   */
  private scrollStrip(image: GrayImage, layout: MenuLayout, box: MenuBox, focused: boolean,
      scroll: MenuScrollAnimation): { image: GrayImage; x: number; top: number } | null {
    const highlight = this.options.highlight;
    if (highlight !== false && (highlight?.depth ?? 0) !== 0) return null;
    const gap = this.options.rowGap ?? 0;
    const selected = this.selected;
    if (selected !== null && layout.tops[selected]! + layout.heights[selected]! - gap - scroll.to > box.height) return null;
    const top = Math.min(scroll.from, scroll.to);
    const bottom = Math.max(scroll.from, scroll.to) + box.height;
    const strip = new GrayImage(box.width, bottom - top, 0);
    for (let index = 0; index < this.itemList.length; index++) {
      const rowTop = layout.tops[index]!;
      const height = layout.heights[index]! - gap;
      const rowBottom = rowTop + height;
      const shownAfter = rowTop >= scroll.to && rowBottom <= scroll.to + box.height;
      const outsideAfter = rowBottom <= scroll.to || rowTop >= scroll.to + box.height;
      if (!shownAfter && !(outsideAfter && rowTop >= top && rowBottom <= bottom)) continue;
      const item = this.itemList[index]!;
      const y = rowTop - top;
      const isSelected = index === selected;
      if (isSelected && highlight !== false) {
        // Clip like the static selected row, which is drawn in a scratch image.
        const row = new GrayImage(box.width, height, 0);
        this.options.draw({ image: row, item, index, x: 0, y: 0, width: box.width, height, selected: true, focused });
        strip.bitBlt(row.withDrawsBaked(), 0, y, { transparentZero: true });
      } else {
        this.options.draw({ image: strip, item, index, x: 0, y, width: box.width, height, selected: isSelected, focused });
      }
    }
    // Crop to the columns with ink; the static paint shows the rest unchanged.
    const baked = strip.withDrawsBaked();
    let left = baked.width, right = -1;
    for (let y = 0; y < baked.height; y++) {
      const row = y * baked.width;
      for (let x = 0; x < left; x++) if (baked.pixels[row + x]! >= 8) { left = x; break; }
      for (let x = baked.width - 1; x > right; x--) if (baked.pixels[row + x]! >= 8) { right = x; break; }
    }
    if (right < left) return null;
    const width = right - left + 1;
    if (5 + Math.ceil(width / 2) * baked.height > MAX_SCROLL_STRIP_BYTES) return null;
    // Whatever the host drew under the copied columns would be covered.
    for (let y = box.y; y < box.y + box.height; y++) {
      for (let x = box.x + left; x <= box.x + right; x++) {
        if (x >= 0 && y >= 0 && x < image.width && y < image.height && image.pixels[y * image.width + x]! >= 8) return null;
      }
    }
    const cropped = new GrayImage(width, baked.height, 0);
    cropped.bitBlt(baked, -left, 0);
    return { image: cropped, x: left, top };
  }

  private isSelectable(index: number): boolean {
    return this.options.isSelectable?.(this.itemList[index]!) ?? true;
  }

  /** The next selectable index after `from` in direction `delta`; from null, the first (or last) selectable. */
  private nextSelectable(from: number | null, delta: -1 | 1): number | null {
    const count = this.itemList.length;
    let index = from === null ? (delta > 0 ? 0 : count - 1) : from + delta;
    for (; index >= 0 && index < count; index += delta) {
      if (this.isSelectable(index)) return index;
    }
    return null;
  }

  /** Resolve a stored selection: null stays null only when the caller deselected. */
  private settle(index: number | null): number | null {
    if (index === null) return this.deselected ? null : this.nextSelectable(null, 1);
    return this.resolve(index);
  }

  /** Clamp an index into range and onto a selectable row (nearest below, else nearest above). */
  private resolve(index: number): number | null {
    if (!this.itemList.length) return null;
    const clamped = Math.max(0, Math.min(this.itemList.length - 1, index | 0));
    if (this.isSelectable(clamped)) return clamped;
    return this.nextSelectable(clamped, 1) ?? this.nextSelectable(clamped, -1);
  }

  /** Re-validate the selection against the current items (they may have been edited in place). */
  private reconcile(): void {
    this.selected = this.settle(this.selected);
  }

  private layout(width: number): MenuLayout {
    const tops: number[] = [];
    const heights: number[] = [];
    let total = 0;
    for (const item of this.itemList) {
      const height = Math.max(0, this.options.getHeight(item, width) | 0);
      tops.push(total);
      heights.push(height);
      total += height;
    }
    if (this.itemList.length) total -= this.options.rowGap ?? 0;
    return { tops, heights, total };
  }

  private maxScroll(layout: MenuLayout, viewportHeight: number): number {
    return Math.max(0, layout.total - viewportHeight);
  }

  /** Scroll the viewport so the selected row is fully inside it, aligning the top to a row edge when it moves. */
  private ensureVisible(layout: MenuLayout, viewportHeight: number): void {
    if (this.selected === null) {
      this.scrollY = Math.max(0, Math.min(this.maxScroll(layout, viewportHeight), this.scrollY));
      return;
    }
    const gap = this.options.rowGap ?? 0;
    const selected = this.selected;
    const top = layout.tops[selected]!;
    const bottom = top + layout.heights[selected]! - gap;
    // Keep the neighbors in view too when all three fit, so the user sees
    // what the next step will reach.
    const contextTop = selected > 0 ? layout.tops[selected - 1]! : top;
    const contextBottom = selected + 1 < this.itemList.length
      ? layout.tops[selected + 1]! + layout.heights[selected + 1]! - gap : bottom;
    const fits = contextBottom - contextTop <= viewportHeight;
    const wantTop = fits ? contextTop : top;
    const wantBottom = fits ? contextBottom : bottom;
    let target = this.scrollY;
    if (wantTop < target) {
      target = wantTop;
    } else if (wantBottom > target + viewportHeight) {
      // A row taller than the viewport shows from its top.
      target = Math.min(top, wantBottom - viewportHeight);
      // Snap to the first row that starts inside the viewport: the wanted
      // rows still fit (their bottom is within viewportHeight of that top).
      for (let index = 0; index <= selected; index++) {
        if (layout.tops[index]! >= target) {
          target = layout.tops[index]!;
          break;
        }
      }
    }
    // Never scroll past the end (setItems can leave the viewport there when
    // rows are removed or inserted above the selection): pull back to the
    // first row top that still shows the last row, so no partial row starts
    // the list. The selected row stays visible, since it ends by the list's end.
    const maxScroll = this.maxScroll(layout, viewportHeight);
    if (target > maxScroll) {
      const aligned = layout.tops.find((rowTop) => rowTop >= maxScroll);
      target = aligned !== undefined && aligned <= target ? aligned : maxScroll;
    }
    this.scrollY = Math.max(0, target);
  }

  /** With nothing selectable, up/down page the content by rows. Returns false at the end being scrolled past. */
  private scrollContent(delta: -1 | 1): boolean {
    if (!this.lastBox) return false;
    const layout = this.layout(this.lastBox.width);
    const maxScroll = this.maxScroll(layout, this.lastBox.height);
    if (delta > 0) {
      if (this.scrollY >= maxScroll) return false;
      const next = layout.tops.find((top) => top > this.scrollY);
      this.scrollY = Math.min(maxScroll, next ?? maxScroll);
    } else {
      if (this.scrollY <= 0) return false;
      let previous = 0;
      for (const top of layout.tops) if (top < this.scrollY) previous = top;
      this.scrollY = Math.max(0, previous);
    }
    return true;
  }
}
