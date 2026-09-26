import { G2_LENS_WIDTH, GrayImage, type UiFont } from "../../graphics/image";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { Menu, type MenuDrawArgs } from "../menu-core";
import { listRowHeight, textInkBounds } from "../metrics";
import { MIN_WINDOW_HEIGHT, minWindowTop } from "./geometry";

/**
 * The shared look of the shell's text dialogs (voice input, phone keyboard
 * input, and the assistant's reply): a solid box over whatever is on screen with a header
 * line (title, then status), the message so far, and either a menu of
 * destinations at the bottom or a gesture hint.
 */

const DIALOG_X = 40;
const DIALOG_W = G2_LENS_WIDTH - 80;
// The dialog fits inside the min-height window band (like the other shell
// overlays), wherever the vertical position setting puts it.
const DIALOG_MARGIN_Y = 28;
const DIALOG_H = MIN_WINDOW_HEIGHT - 2 * DIALOG_MARGIN_Y;
const TEXT_MAX_WIDTH = DIALOG_W - 32;
const TEXT_LEFT = DIALOG_X + 16;
// Menu row boxes: 4px left of the text column, 2px shorter than the row
// pitch, with each row's label inset 8px / 4px into its box.
const MENU_X = TEXT_LEFT - 4;
const MENU_W = DIALOG_W - 24;
const MENU_ROW_GAP = 2;
const MENU_LABEL_INSET_X = 8;
const MENU_LABEL_INSET_Y = 4;
const HEADER_STATUS_GAP = 10;
const HINT_VALUE = 100;
const HINT_DEPTH = 2;

/** Dialog top edge; band-relative, so computed per paint. */
function dialogY(): number {
  return minWindowTop() + DIALOG_MARGIN_Y;
}

export type InputDialogRow = {
  label: string;
  /** Drawn faint: the row is not currently selectable (e.g. nothing to send). */
  dim: boolean;
};

export type InputDialogContent<T extends InputDialogRow = InputDialogRow> = {
  title: string;
  status: string;
  /** Gray level of the status line. Default 130. */
  statusValue?: number;
  /** The message body (a placeholder when nothing has been captured yet). */
  text: string;
  /**
   * Menu along the bottom edge (see createInputDialogMenu), or null for none.
   * Height is reserved for every item.
   */
  menu: Menu<T> | null;
  /** Gesture hint drawn along the bottom edge when there is no menu. */
  hint?: string;
};

/**
 * A wrapping menu of dialog rows, laid out and drawn the way paintInputDialog
 * expects. The owning layer keeps it across paints (so the selection sticks),
 * refreshes its rows with setItems, forwards scroll events to it, and hands
 * it to paintInputDialog while the menu is showing.
 */
export function createInputDialogMenu<T extends InputDialogRow>(items: readonly T[] = [], selectedIndex = 0): Menu<T> {
  return new Menu<T>({
    items,
    selectedIndex,
    wrap: true,
    rowGap: MENU_ROW_GAP,
    highlight: { radius: 6 },
    getHeight: () => listRowHeight(getDefaultSmallFont()),
    draw: drawMenuRow,
  });
}

function drawMenuRow({ image, item, x, y, selected }: MenuDrawArgs<InputDialogRow>): void {
  const value = item.dim ? 90 : selected ? 255 : 200;
  image.drawText(getDefaultSmallFont(), x + MENU_LABEL_INSET_X, y + MENU_LABEL_INSET_Y, item.label, value);
}

/** Paint the dialog onto `image` (an already-painted canvas of the layers below). */
export function paintInputDialog<T extends InputDialogRow>(image: GrayImage, content: InputDialogContent<T>): void {
  const font = getDefaultSmallFont();
  const menuRowH = listRowHeight(font);
  const top = dialogY();

  // Solid dialog box over the underlying UI. Fill 1, not 0: identical after
  // 4bpp quantization, but 0 is transparent on the color-key shell surface.
  image.fillRect(DIALOG_X, top, DIALOG_W, DIALOG_H, 1);
  image.drawRect(DIALOG_X, top, DIALOG_W, DIALOG_H, 90);

  // Title and status share one header line, the status in the space after the title.
  const left = TEXT_LEFT;
  const headerY = top + 12;
  image.drawText(font, left, headerY, content.title, 220);
  const statusLeft = left + Math.ceil(font.measureText(content.title)) + HEADER_STATUS_GAP;
  const statusWidth = TEXT_LEFT + TEXT_MAX_WIDTH - statusLeft;
  image.drawText(font, statusLeft, headerY, truncateText(font, content.status, statusWidth), content.statusValue ?? 130);

  const menu = content.menu;
  const rowCount = menu?.items.length ?? 0;
  // Reserve space for the actual number of rows this menu has, or one row for the hint.
  const reservedRows = rowCount > 0 ? rowCount : content.hint ? 1 : 0;
  const textBottom = top + DIALOG_H - reservedRows * menuRowH - 8;
  const textTop = headerY + font.lineHeight + 12;
  const maxLines = Math.max(1, ((textBottom - textTop) / 16) | 0);

  // The tail of a long message stays in view: it is what was said last (or
  // where the phone keyboard is typing).
  const wrapped = wrapText(font, content.text, TEXT_MAX_WIDTH);
  const firstLine = Math.max(0, wrapped.length - maxLines);
  for (let index = firstLine; index < wrapped.length; index++) {
    image.drawText(font, left, textTop + (index - firstLine) * 16, wrapped[index]!, 235);
  }

  if (menu && rowCount > 0) {
    // Row boxes are one pitch apart, the last ending 6px above the dialog's bottom edge.
    const menuTop = top + DIALOG_H - rowCount * menuRowH - 4;
    menu.paint(image, { x: MENU_X, y: menuTop, width: MENU_W, height: rowCount * menuRowH - MENU_ROW_GAP }, true);
  } else if (content.hint) {
    // On the line the last menu row's label would occupy, floating in front of the dialog.
    drawDepthText(image, font, truncateText(font, content.hint, TEXT_MAX_WIDTH), left, top + DIALOG_H - menuRowH, HINT_VALUE, HINT_DEPTH);
  }
}

/**
 * Draw one line of text at stereo depth: rendered into its own image (sized
 * to the font's ink, which can overshoot the line box) and replayed at depth.
 */
function drawDepthText(image: GrayImage, font: UiFont, text: string, x: number, y: number, value: number, depth: number): void {
  const ink = textInkBounds(font);
  const above = Math.max(0, -ink.top);
  const source = new GrayImage(Math.ceil(font.measureText(text)) + 2, above + Math.max(font.lineHeight, ink.bottom));
  source.drawText(font, 0, above, text, value);
  image.drawDepthImage(source, x, y - above, depth);
}
