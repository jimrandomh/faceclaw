/**
 * Word wrap for EvenHub text containers, after LVGL's lv_text_get_next_line
 * as ported by @evenrealities/pretext's measureTextWrap, so soft breaks land
 * where apps that measure with pretext expect them. The loop mirrors
 * measureTextWrap's, including rescanning from the break point when it wraps
 * at an earlier opportunity.
 *
 * One deliberate difference from pretext: pretext skips leading spaces at the
 * start of every line, but stock keeps them at the start of the text and after
 * a '\n'; only a soft-wrapped continuation line loses them. Apps indent with
 * spaces to clear image containers placed beside their text: Iris Pro indents a
 * line 11 spaces (44px) past a 40px glyph. Stripping that indent slid the text
 * under the icon.
 */

/** Wrap opportunities: space, hyphen, and between CJK ideographs (pretext parity). */
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
  // many of `line`'s codepoints a wrap there keeps (a breaking space is dropped).
  let lastBreak = -1;
  let lastBreakKeep = 0;
  // Whether `line` continues a soft-wrapped line, whose leading spaces are dropped.
  let continuation = false;

  const endLine = (keep: number[], next: number[], nextWidth: number) => {
    lines.push(String.fromCodePoint(...keep));
    line = next;
    lineWidth = nextWidth;
    lastBreak = -1;
    continuation = true;
  };

  let i = 0;
  while (i < cps.length) {
    const cp = cps[i]!;
    if (cp === 10) {
      endLine(line, [], 0);
      continuation = false;
      i++;
      continue;
    }
    if (continuation && line.length === 0 && cp === 32) {
      i++;
      continue;
    }
    const adv = advanceOf(cp, cps[i + 1] ?? 0);
    if (lineWidth + adv <= maxWidth) {
      line.push(cp);
      lineWidth += adv;
      if (isLvglBreakable(cp)) {
        lastBreak = i;
        lastBreakKeep = cp === 32 ? line.length - 1 : line.length;
      }
      i++;
    } else if (cp === 32) {
      // The overflowing char is a space: break here and discard it.
      endLine(line, [], 0);
      i++;
    } else if (lastBreak !== -1) {
      // Wrap at the last break opportunity and rescan from just after it.
      const restart = lastBreak + 1;
      endLine(line.slice(0, lastBreakKeep), [], 0);
      i = restart;
    } else {
      // No break opportunity: hard break before the overflowing char.
      endLine(line, [cp], adv);
      i++;
    }
  }
  lines.push(String.fromCodePoint(...line));
  return lines;
}
