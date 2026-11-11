import { wrapText, type WrapFont } from '../../graphics/textwrap';
import type { Edges } from '../../ui/viewport';

/**
 * Where the hub's title line (and a wrapped status block under it) starts,
 * right of the window's left padding: the list's selection boxes start at
 * the padding and unindented row text sits this far inside its box, so the
 * title lines up with it.
 */
export const HUB_TITLE_INSET_X = 6;
/** The title line's top, below the window's top padding. */
const HUB_TITLE_OFFSET_Y = 2;
/** Between the title and a status that shares its row. */
const HUB_STATUS_GAP = 16;
/** Between the header's last line and the list's first text line. */
const HUB_LIST_GAP = 6;

/**
 * Lay the hub's header out in a window `width` wide with the suggested
 * `padding` (viewport.ts): the title inside the top and left padding, the
 * status ending at the right padding. Keep short status on the title row;
 * give long errors their full width.
 */
export function layoutHubHeader(
  font: WrapFont,
  title: string,
  status: string,
  viewport: { width: number; padding: Edges<number> },
  step: number,
) {
  const { width, padding } = viewport;
  const titleX = padding.left + HUB_TITLE_INSET_X;
  const titleY = padding.top + HUB_TITLE_OFFSET_Y;
  const right = width - padding.right;
  const inlineX = titleX + font.measureText(title) + HUB_STATUS_GAP;
  const inline = !/[\r\n]/.test(status) && font.measureText(status) <= Math.max(0, right - inlineX);
  const lines = inline ? [status] : wrapText(font, status, Math.max(1, right - titleX));
  const x = inline ? inlineX : titleX;
  const y = inline ? titleY : titleY + step;
  return { titleX, titleY, x, y, lines, listTop: titleY + HUB_LIST_GAP + step * (inline ? 1 : 1 + lines.length) };
}
