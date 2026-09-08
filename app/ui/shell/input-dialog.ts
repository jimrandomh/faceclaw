import { windowLayoutPolicy, typographyPolicy } from "../extension-settings";
import { G2_LENS_WIDTH, type GrayImage } from "../../graphics/image";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { drawSelectionHighlight } from "../menu";
import { listRowHeight } from "../metrics";
import { MIN_WINDOW_HEIGHT, minWindowTop, appViewportRect } from "./geometry";

/**
 * The shared look of the shell's text-entry dialogs (voice input and phone
 * keyboard input): a solid box over whatever is on screen with a title line,
 * a status line, the message so far, and either a menu of destinations at
 * the bottom or a gesture hint.
 */

const DIALOG_X = 40;
const DIALOG_W = G2_LENS_WIDTH - 80;
// The dialog fits inside the min-height window band (like the other shell
// overlays), wherever the vertical position setting puts it.
const DIALOG_MARGIN_Y = 24;
const DIALOG_H = MIN_WINDOW_HEIGHT - 2 * DIALOG_MARGIN_Y;
const TEXT_MAX_WIDTH = DIALOG_W - 32;

/** Dialog top edge; band-relative, so computed per paint. */
function dialogY(): number {
  return minWindowTop() + DIALOG_MARGIN_Y;
}

export type InputDialogRow = {
  label: string;
  /** Drawn faint: the row is not currently selectable (e.g. nothing to send). */
  dim: boolean;
};

export type InputDialogContent = {
  title: string;
  status: string;
  /** The message body (a placeholder when nothing has been captured yet). */
  text: string;
  /** Menu rows along the bottom edge; empty for no menu. */
  rows: readonly InputDialogRow[];
  selectedRow: number;
  /** Gesture hint drawn along the bottom edge when there is no menu. */
  hint?: string;
};

/** Paint the dialog onto `image` (an already-painted canvas of the layers below). */
export function paintInputDialog(image: GrayImage, content: InputDialogContent): void {
  const font = getDefaultSmallFont();
  const menuRowH = listRowHeight(font);
  const expanded = windowLayoutPolicy().inputDialogs === "viewport";
  const viewport = appViewportRect("medium");
  const dialogX = expanded ? viewport.x + 8 : DIALOG_X;
  const dialogWidth = expanded ? viewport.width - 16 : DIALOG_W;
  const dialogHeight = expanded ? viewport.height - 16 : DIALOG_H;
  const textWidth = dialogWidth - 32;
  const top = expanded ? viewport.y + 8 : dialogY();
  const lineHeight = expanded ? font.lineHeight + 5 : 16;
  const style = typographyPolicy();
  if (expanded) image.bakeDeferredDrawsInPlace();

  // Solid dialog box over the underlying UI. Fill 1, not 0: identical after
  // 4bpp quantization, but 0 is transparent on the color-key shell surface.
  image.fillRoundedRect(dialogX, top, dialogWidth, dialogHeight, 1, style.cardRadius ?? 10);
  image.drawRoundedRect(dialogX, top, dialogWidth, dialogHeight, 90, style.cardRadius ?? 10, style.borderWidth ?? (expanded ? 2 : 1));

  const left = dialogX + 16;
  image.drawText(font, left, top + 12, expanded ? truncateText(font, content.title, textWidth) : content.title, expanded ? 190 : 220);
  image.drawText(font, left, top + (expanded ? 12 + lineHeight : 30), truncateText(font, content.status, textWidth), 130);

  const rows = content.rows;
  const hasMenu = rows.length > 0;
  // Reserve space for the actual number of rows this menu has.
  const textBottom = hasMenu ? top + dialogHeight - rows.length * menuRowH - 8 : top + dialogHeight - (expanded && content.hint ? lineHeight + 12 : 8);
  const textTop = top + (expanded ? 20 + 2 * lineHeight : 56);
  const maxLines = Math.max(1, ((textBottom - textTop) / lineHeight) | 0);

  // The tail of a long message stays in view: it is what was said last (or
  // where the phone keyboard is typing).
  const wrapped = wrapText(font, content.text, textWidth, { preserveLeadingWhitespace: expanded });
  const firstLine = Math.max(0, wrapped.length - maxLines);
  for (let index = firstLine; index < wrapped.length; index++) {
    image.drawText(font, left, textTop + (index - firstLine) * lineHeight, wrapped[index]!, expanded ? 190 : 235);
  }

  if (hasMenu) {
    const menuTop = top + dialogHeight - rows.length * menuRowH - 2;
    for (let i = 0; i < rows.length; i++) {
      const rowY = menuTop + i * menuRowH;
      const selected = i === content.selectedRow;
      if (selected) {
        drawSelectionHighlight(image, left - 4, rowY - 2, dialogWidth - 24, menuRowH - 2, true, 6);
      }
      const row = rows[i]!;
      image.drawText(font, left + 4, rowY + 2, truncateText(font, row.label, textWidth - 4), row.dim ? 90 : selected ? 255 : 200);
    }
  } else if (content.hint) {
    image.drawText(font, left, top + dialogHeight - (expanded ? font.lineHeight + 8 : 14), truncateText(font, content.hint, textWidth), expanded ? 110 : 110 - font.lineHeight);
  }
}
