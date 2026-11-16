/**
 * Word wrap for EvenHub text containers, matching the stock firmware's LVGL
 * labels as measured by running firmware 2.2.9.22 in the g2-firmware-emulator:
 *
 * - Spaces are kept wherever they fall: at the start of the text, after a
 *   '\n', and on soft-wrapped lines. A space that doesn't fit at the end of a
 *   line starts the next one, so "HHHHHHHH    EEEE" in 100px (8 H = 96px,
 *   5px spaces) wraps with all four spaces indenting the second line.
 * - A line otherwise breaks after its last space, hyphen or CJK ideograph,
 *   or, with none, before the character that overflows.
 *
 * @evenrealities/pretext's measureTextWrap, which apps measure with, differs
 * in one way: it drops spaces at the start of every line. Apps rely on stock's
 * behavior, though: Iris Pro indents a line 11 spaces past a 40px glyph placed
 * beside it, and stripping the indent slid the text under the icon.
 */

/** Wrap opportunities: space, hyphen, and between CJK ideographs. */
export function isLvglBreakable(cp: number): boolean {
  if (cp === 32 || cp === 45) return true;
  return (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xac00 && cp <= 0xd7af);
}

/**
 * Split text into display lines no wider than maxWidth.
 * `advanceOf(cp, next)` is the kerned pixel advance of cp before next (0 at the end).
 */
export function wrapLvglText(text: string, maxWidth: number, advanceOf: (cp: number, next: number) => number): string[] {
  if (!text) return [""];
  const cps = Array.from(text).map((c) => c.codePointAt(0)!);
  const lines: string[] = [];
  let line: number[] = [];
  let lineWidth = 0;
  // The last break opportunity on this line, as an index into cps, and how
  // many of `line`'s codepoints end at it.
  let lastBreak = -1;
  let lastBreakKeep = 0;

  const endLine = (keep: number[]) => {
    lines.push(String.fromCodePoint(...keep));
    line = [];
    lineWidth = 0;
    lastBreak = -1;
  };

  let i = 0;
  while (i < cps.length) {
    const cp = cps[i]!;
    if (cp === 10) {
      endLine(line);
      i++;
      continue;
    }
    const adv = advanceOf(cp, cps[i + 1] ?? 0);
    if (lineWidth + adv <= maxWidth || line.length === 0) {
      // A character wider than the whole line still takes one to itself.
      line.push(cp);
      lineWidth += adv;
      if (isLvglBreakable(cp)) {
        lastBreak = i;
        lastBreakKeep = line.length;
      }
      i++;
    } else if (cp !== 32 && lastBreak !== -1) {
      // Wrap after the last break opportunity and rescan from there.
      const restart = lastBreak + 1;
      endLine(line.slice(0, lastBreakKeep));
      i = restart;
    } else {
      // An overflowing space, or no break opportunity: this character starts the next line.
      endLine(line);
    }
  }
  lines.push(String.fromCodePoint(...line));
  return lines;
}
