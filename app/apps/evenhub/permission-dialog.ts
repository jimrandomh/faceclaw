import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext, type PaintBelow } from "../../ui/layers";
import { drawListScrollbar, drawSelectionHighlight } from "../../ui/menu";
import { permissionDetail, permissionLabel, type EvenHubPermission } from "./permissions";
import { openPrivacyPolicyOnPhone } from "./privacy-policy";
import { lineStep, listRowHeight } from "../../ui/metrics";

const DIALOG_X = 8;
const DIALOG_Y = 8;
const DIALOG_WIDTH = 272;
const PADDING = 10;
const PERM_GAP = 4;

/**
 * Confirmation dialog listing the permissions an EvenHub app declares, shown
 * before installing it or running an uninstalled package. Allow proceeds;
 * Cancel (or double-click) backs out. A privacy-policy-only app still reaches
 * this dialog so the user can review the policy before allowing first run.
 *
 * When the list overflows the viewport the dialog scrolls: scroll events move
 * through the content row by row, and only once the bottom is fully visible do
 * further scrolls move the action selection. The actions are inert until then
 * (a click just scrolls), so the user can't Allow without having had the whole
 * list on screen.
 */
export class EvenHubPermissionDialogLayer implements Layer {
  /** Starts on Allow; the optional privacy-policy action is inserted after it. */
  private selectedIndex = 0;
  /** First content row drawn; rows above it are scrolled off. */
  private firstRow = 0;
  /** Scroll position at which the last row is fully visible; set by paint. */
  private maxFirstRow = 0;
  private resolved = false;

  constructor(
    private readonly appName: string,
    private readonly permissions: EvenHubPermission[],
    private readonly privacyPolicyUrl: string,
    private readonly onConfirm: () => void,
    private readonly onCancel: () => void,
  ) {}

  /** Whether the dialog is scrolled to the bottom, making the actions live. */
  private atBottom(): boolean {
    return this.firstRow >= this.maxFirstRow;
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const font = getDefaultSmallFont();
    const { height: viewportHeight } = ctx.stack.getBaseSize();
    const image = paintBelow();
    const textWidth = DIALOG_WIDTH - 2 * PADDING - 4;
    const left = DIALOG_X + PADDING + 2;

    const headerStep = lineStep(font) + 2;
    const permLabelStep = lineStep(font) + 1;
    const permDetailStep = lineStep(font) - 1;
    const actionRowH = listRowHeight(font);
    const actions = this.actions();
    const focused = ctx.stack.isFocused();

    // The dialog body as scrollable rows; each row's height includes the gap
    // below it, so scrolling and visibility checks work on whole rows.
    type Row = { height: number; draw: (top: number) => void };
    const rows: Row[] = [];
    const heading = this.permissions.length ? `${this.appName} needs:` : `${this.appName} is ready to run`;
    rows.push({
      height: headerStep + 6,
      draw: (top) => image.drawText(font, left, top, truncateText(font, heading, textWidth), 235),
    });
    if (this.permissions.length === 0) {
      rows.push({
        height: permLabelStep + PERM_GAP + 2,
        draw: (top) => image.drawText(font, left, top, "No special permissions requested.", 140),
      });
    }
    for (let index = 0; index < this.permissions.length; index++) {
      const permission = this.permissions[index]!;
      const detail = permissionDetail(permission);
      const gapBelow = PERM_GAP + (index === this.permissions.length - 1 ? 2 : 0);
      rows.push({
        height: permLabelStep + (detail ? 0 : gapBelow),
        draw: (top) => image.drawText(font, left, top, truncateText(font, permissionLabel(permission.name), textWidth), 220),
      });
      if (detail) {
        rows.push({
          height: permDetailStep + gapBelow,
          draw: (top) => image.drawText(font, left + 8, top, truncateText(font, detail, textWidth - 8), 140),
        });
      }
    }
    for (let index = 0; index < actions.length; index++) {
      rows.push({
        height: actionRowH,
        draw: (top) => {
          const selected = this.atBottom() && index === this.selectedIndex;
          if (selected) {
            drawSelectionHighlight(image, DIALOG_X + 12, top, DIALOG_WIDTH - 24, actionRowH - 1, focused, 8);
          }
          image.drawText(font, DIALOG_X + 22, top + 3, actions[index]!, selected ? 255 : 200);
        },
      });
    }

    const contentHeight = rows.reduce((sum, row) => sum + row.height, 0);
    const height = Math.min(contentHeight + 2 * PADDING, viewportHeight - 2 * DIALOG_Y);
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

    // Fill 1 (transparent color key is 0), outline for the dialog edge.
    image.fillRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_WIDTH, height, 1);
    image.drawRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_WIDTH, height, 72);

    let y = DIALOG_Y + PADDING;
    for (let index = this.firstRow; index < rows.length; index++) {
      const row = rows[index]!;
      if (y + row.height > DIALOG_Y + PADDING + visibleHeight) break;
      row.draw(y);
      y += row.height;
    }

    if (maxFirstRow > 0) {
      drawListScrollbar(
        image,
        DIALOG_X + DIALOG_WIDTH - 7,
        DIALOG_Y + PADDING,
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
          this.firstRow -= 1;
        }
        return;
      case "scroll-down":
        if (!this.atBottom()) {
          this.firstRow += 1;
        } else {
          this.selectedIndex = Math.min(actions.length - 1, this.selectedIndex + 1);
        }
        return;
      case "click":
        if (!this.atBottom()) {
          this.firstRow += 1;
          return;
        }
        if (actions[this.selectedIndex] === "Privacy policy") {
          openPrivacyPolicyOnPhone(this.privacyPolicyUrl, this.appName);
        } else {
          this.resolve(ctx, actions[this.selectedIndex] === "Allow");
        }
        return;
      case "double-click":
        this.resolve(ctx, false);
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    // Dismissed some other way (window closed, back button): treat as cancel.
    if (!this.resolved) {
      this.resolved = true;
      this.onCancel();
    }
  }

  private resolve(ctx: LayerContext, confirmed: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    ctx.stack.pop();
    if (confirmed) this.onConfirm();
    else this.onCancel();
  }

  private actions(): string[] {
    return this.privacyPolicyUrl ? ["Allow", "Privacy policy", "Cancel"] : ["Allow", "Cancel"];
  }
}
