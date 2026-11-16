import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { type GrayImage, type UiFont } from "../../graphics/image";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext, type PaintBelow } from "../../ui/layers";
import { drawListScrollbar, drawSelectionHighlight } from "../../ui/menu";
import { listRowHeight } from "../../ui/metrics";

/** Minimum gap between the dialog and the edges of the window it's centered in. */
const DIALOG_MARGIN = 8;
const PADDING = 10;

/** One row of a dialog's content. Its height includes the gap below it, so scrolling works on whole rows. */
export type DialogRow = { height: number; draw: (top: number) => void };

/** What a dialog's body rows draw with: the canvas, the font, and the text column. */
export type DialogBody = { image: GrayImage; font: UiFont; left: number; textWidth: number };

/**
 * A dialog box centered over the window it opens in: body rows, then a
 * column of actions, starting on the first. EvenHub's confirmations and
 * warnings (permissions, the RayNeo iO display warning) are built on it.
 *
 * When the content overflows the viewport the dialog scrolls a page at a
 * time, keeping one line of overlap (the last line of one page is the first
 * of the next), and only once the bottom is fully visible do further scrolls
 * move the action selection. The actions are inert until then (a click just
 * pages down), so nothing can be chosen without the whole dialog having been
 * on screen. Double-click backs out.
 */
export abstract class ScrollingDialogLayer implements Layer {
  /** Floats in front of the window content, like the context menus. */
  readonly depth = 2;
  private selectedIndex = 0;
  /** First content row drawn; rows above it are scrolled off. */
  private firstRow = 0;
  /** Scroll position at which the last row is fully visible; set by paint. */
  private maxFirstRow = 0;
  /** Heights of the content rows and of the viewport they scroll in, as last painted (for paging). */
  private rowHeights: number[] = [];
  private visibleHeight = 0;
  private resolved = false;

  constructor(private readonly maxWidth: number) {}

  /** The rows above the actions. */
  protected abstract bodyRows(body: DialogBody): DialogRow[];
  /** The action labels, top to bottom. */
  protected abstract actions(): string[];
  /** A click on an action once the actions are live; close() dismisses the dialog with it. */
  protected abstract activate(action: string, ctx: LayerContext): void;
  /** Double-click: the user backed out of the dialog. */
  protected abstract backedOut(): void;
  /** The dialog left the stack unanswered (its window closed). */
  protected abstract abandoned(): void;

  /** Whether the dialog is scrolled to the bottom, making the actions live. */
  private atBottom(): boolean {
    return this.firstRow >= this.maxFirstRow;
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const font = getDefaultSmallFont();
    const { width: viewportWidth, height: viewportHeight } = ctx.stack.getBaseSize();
    const image = paintBelow();
    const dialogWidth = Math.min(this.maxWidth, viewportWidth - 2 * DIALOG_MARGIN);
    const dialogX = ((viewportWidth - dialogWidth) / 2) | 0;
    const textWidth = dialogWidth - 2 * PADDING - 4;
    const left = dialogX + PADDING + 2;

    const actionRowH = listRowHeight(font);
    const actions = this.actions();
    const focused = ctx.stack.isFocused();

    const rows = this.bodyRows({ image, font, left, textWidth });
    for (let index = 0; index < actions.length; index++) {
      rows.push({
        height: actionRowH,
        draw: (top) => {
          const selected = this.atBottom() && index === this.selectedIndex;
          if (selected) {
            drawSelectionHighlight(image, dialogX + 12, top, dialogWidth - 24, actionRowH - 1, focused, 8);
          }
          image.drawText(font, dialogX + 22, top + 3, actions[index]!, selected ? 255 : 200);
        },
      });
    }

    const contentHeight = rows.reduce((sum, row) => sum + row.height, 0);
    const height = Math.min(contentHeight + 2 * PADDING, viewportHeight - 2 * DIALOG_MARGIN);
    const dialogY = ((viewportHeight - height) / 2) | 0;
    const visibleHeight = height - 2 * PADDING;

    // The bottommost scroll position: the largest suffix of rows that fits.
    let maxFirstRow = rows.length;
    for (let suffixHeight = 0; maxFirstRow > 0; maxFirstRow--) {
      const rowHeight = rows[maxFirstRow - 1]!.height;
      if (suffixHeight + rowHeight > visibleHeight) break;
      suffixHeight += rowHeight;
    }
    this.maxFirstRow = maxFirstRow;
    this.firstRow = Math.max(0, Math.min(this.firstRow, maxFirstRow));
    this.rowHeights = rows.map((row) => row.height);
    this.visibleHeight = visibleHeight;

    // Fill 1 (transparent color key is 0), outline for the dialog edge.
    image.fillRoundedRect(dialogX, dialogY, dialogWidth, height, 1);
    image.drawRoundedRect(dialogX, dialogY, dialogWidth, height, 72);

    let y = dialogY + PADDING;
    for (let index = this.firstRow; index < rows.length; index++) {
      const row = rows[index]!;
      if (y + row.height > dialogY + PADDING + visibleHeight) break;
      row.draw(y);
      y += row.height;
    }

    if (maxFirstRow > 0) {
      drawListScrollbar(
        image,
        dialogX + dialogWidth - 7,
        dialogY + PADDING,
        visibleHeight,
        this.firstRow,
        rows.length - maxFirstRow,
        rows.length,
      );
    }
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    const actions = this.actions();
    switch (event.type) {
      case "scroll-up":
        if (this.atBottom() && this.selectedIndex > 0) {
          this.selectedIndex -= 1;
        } else if (this.firstRow > 0) {
          this.pageUp();
        }
        return;
      case "scroll-down":
        if (!this.atBottom()) {
          this.pageDown();
        } else {
          this.selectedIndex = Math.min(actions.length - 1, this.selectedIndex + 1);
        }
        return;
      case "click":
        if (!this.atBottom()) {
          this.pageDown();
          return;
        }
        this.activate(actions[this.selectedIndex]!, ctx);
        return;
      case "double-click":
        this.close(ctx, () => this.backedOut());
        return;
      default:
        return;
    }
  }

  /** Scroll so the last fully visible row becomes the first (one row of overlap). */
  private pageDown(): void {
    let y = 0;
    let lastVisible = this.firstRow;
    for (let index = this.firstRow; index < this.rowHeights.length; index++) {
      y += this.rowHeights[index]!;
      if (y > this.visibleHeight) break;
      lastVisible = index;
    }
    this.firstRow = Math.min(this.maxFirstRow, Math.max(this.firstRow + 1, lastVisible));
  }

  /** Scroll so the current first row becomes the last fully visible one (one row of overlap). */
  private pageUp(): void {
    let first = this.firstRow;
    let y = this.rowHeights[first] ?? 0;
    while (first > 0 && y + this.rowHeights[first - 1]! <= this.visibleHeight) {
      first -= 1;
      y += this.rowHeights[first]!;
    }
    this.firstRow = Math.max(0, Math.min(this.firstRow - 1, first));
  }

  onRemoved(): void {
    // Dismissed some other way (window closed, back button).
    if (!this.resolved) {
      this.resolved = true;
      this.abandoned();
    }
  }

  /** Take the dialog down, then run the answer's effect (once, however it was answered). */
  protected close(ctx: LayerContext, then: () => void): void {
    if (this.resolved) return;
    this.resolved = true;
    ctx.stack.pop();
    then();
  }
}
