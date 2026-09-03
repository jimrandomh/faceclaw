import { G2_LENS_WIDTH, type GrayImage } from "../../graphics/image";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { drawSelectionHighlight } from "../menu";
import { listRowHeight } from "../metrics";
import { MIN_WINDOW_HEIGHT, minWindowTop } from "./geometry";

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
  const top = dialogY();

  // Solid dialog box over the underlying UI. Fill 1, not 0: identical after
  // 4bpp quantization, but 0 is transparent on the color-key shell surface.
  image.fillRoundedRect(DIALOG_X, top, DIALOG_W, DIALOG_H, 1, 10);
  image.drawRoundedRect(DIALOG_X, top, DIALOG_W, DIALOG_H, 90, 10);

  const left = DIALOG_X + 16;
  image.drawText(font, left, top + 12, content.title, 220);
  image.drawText(font, left, top + 30, truncateText(font, content.status, TEXT_MAX_WIDTH), 130);

  const rows = content.rows;
  const hasMenu = rows.length > 0;
  // Reserve space for the actual number of rows this menu has.
  const textBottom = hasMenu ? top + DIALOG_H - rows.length * menuRowH - 8 : top + DIALOG_H - 8;
  const textTop = top + 56;
  const maxLines = Math.max(1, ((textBottom - textTop) / 16) | 0);

  // The tail of a long message stays in view: it is what was said last (or
  // where the phone keyboard is typing).
  const wrapped = wrapText(font, content.text, TEXT_MAX_WIDTH);
  const firstLine = Math.max(0, wrapped.length - maxLines);
  for (let index = firstLine; index < wrapped.length; index++) {
    image.drawText(font, left, textTop + (index - firstLine) * 16, wrapped[index]!, 235);
  }

  if (hasMenu) {
    const menuTop = top + DIALOG_H - rows.length * menuRowH - 2;
    for (let i = 0; i < rows.length; i++) {
      const rowY = menuTop + i * menuRowH;
      const selected = i === content.selectedRow;
      if (selected) {
        drawSelectionHighlight(image, left - 4, rowY - 2, DIALOG_W - 24, menuRowH - 2, true, 6);
      }
      const row = rows[i]!;
      image.drawText(font, left + 4, rowY + 2, row.label, row.dim ? 90 : selected ? 255 : 200);
    }
  } else if (content.hint) {
    image.drawText(font, left, top + DIALOG_H - 14, content.hint, 110 - font.lineHeight);
  }
}
