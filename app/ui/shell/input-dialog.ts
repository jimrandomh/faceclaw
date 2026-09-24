import { G2_LENS_WIDTH, type GrayImage } from "../../graphics/image";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { Menu, type MenuDrawArgs } from "../menu-core";
import { listRowHeight } from "../metrics";
import { MIN_WINDOW_HEIGHT, minWindowTop } from "./geometry";

/**
 * The shared look of the shell's text dialogs (voice input, phone keyboard
 * input, and the assistant's reply): a solid box over whatever is on screen with a title line,
 * a status line, the message so far, and either a menu of destinations at
 * the bottom or a gesture hint.
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

  const left = TEXT_LEFT;
  image.drawText(font, left, top + 12, content.title, 220);
  image.drawText(font, left, top + 30, truncateText(font, content.status, TEXT_MAX_WIDTH), content.statusValue ?? 130);

  const menu = content.menu;
  const rowCount = menu?.items.length ?? 0;
  // Reserve space for the actual number of rows this menu has.
  const textBottom = rowCount > 0 ? top + DIALOG_H - rowCount * menuRowH - 8 : top + DIALOG_H - 8;
  const textTop = top + 56;
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
    image.drawText(font, left, top + DIALOG_H - 14, content.hint, 110 - font.lineHeight);
  }
}
