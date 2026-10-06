import { wrapText, type WrapFont } from '../../graphics/textwrap';

/** Left edge of the hub's title line (and of a wrapped status block under it). */
export const HUB_TITLE_X = 12;

/** Keep short status on the title row; give long errors their full width. */
export function layoutHubHeader(font: WrapFont, title: string, status: string, width: number, step: number) {
  const inlineX = HUB_TITLE_X + font.measureText(title) + 16;
  const inline = !/[\r\n]/.test(status) && font.measureText(status) <= Math.max(0, width - inlineX - 12);
  const lines = inline ? [status] : wrapText(font, status, Math.max(1, width - HUB_TITLE_X - 12));
  const x = inline ? inlineX : HUB_TITLE_X;
  const y = inline ? 10 : 10 + step;
  return { x, y, lines, listTop: inline ? 16 + step : 16 + step * (1 + lines.length) };
}
