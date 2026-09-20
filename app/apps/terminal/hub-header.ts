import { wrapText, type WrapFont } from '../../graphics/textwrap';

/** Keep short status on the title row; give long errors their full width. */
export function layoutHubHeader(font: WrapFont, title: string, status: string, width: number, step: number) {
  const inlineX = 18 + font.measureText(title) + 16;
  const inline = !/[\r\n]/.test(status) && font.measureText(status) <= Math.max(0, width - inlineX - 12);
  const lines = inline ? [status] : wrapText(font, status, Math.max(1, width - 30));
  const x = inline ? inlineX : 18;
  const y = inline ? 10 : 10 + step;
  return { x, y, lines, listTop: inline ? 16 + step : 16 + step * (1 + lines.length) };
}
