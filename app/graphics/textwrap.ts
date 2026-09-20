/**
 * What wrapping and truncation need from a font. BdfFont and TtfFont both
 * satisfy it structurally: getGlyph feeds per-codepoint advances for wrap
 * measurement (integer and kerning-free, so slightly conservative for kerned
 * faces), measureText feeds truncation.
 */
export interface WrapFont {
  measureText(text: string): number;
  getGlyph(codePoint: number): { dwidthX: number } | undefined;
}

export type WrapTextOptions = {
  preserveLeadingWhitespace?: boolean;
  breakLongWords?: boolean;
};

export function findWrapOpportunities(text: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(codePoint);
    const next = i + char.length;

    if (isWhitespace(char)) {
      let end = next;
      while (end < text.length) {
        const innerCodePoint = text.codePointAt(end) ?? 0;
        const innerChar = String.fromCodePoint(innerCodePoint);
        if (!isWhitespace(innerChar) || innerChar === "\n") break;
        end += innerChar.length;
      }
      offsets.push(end);
      i = end;
      continue;
    }

    if (isBreakAfter(char)) {
      offsets.push(next);
    }

    i = next;
  }
  return offsets;
}

export function wrapText(font: WrapFont, text: string, targetWidth: number, opts: WrapTextOptions = {}): string[] {
  if (targetWidth <= 0) {
    return text.length ? text.split("\n") : [""];
  }

  const paragraphs = text.replace(/\r/g, "").split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    lines.push(...wrapParagraph(font, paragraph, targetWidth, opts));
  }
  return lines.length ? lines : [""];
}

export function truncateText(font: WrapFont, text: string, maxWidth: number): string {
  if (font.measureText(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.measureText(`${out}...`) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

export function truncateLeft(font: WrapFont, text: string, maxWidth: number): string {
  if (font.measureText(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.measureText(`...${out}`) > maxWidth) {
    out = out.slice(1);
  }
  return `...${out}`;
}

function wrapParagraph(font: WrapFont, paragraph: string, targetWidth: number, opts: WrapTextOptions): string[] {
  if (paragraph.length === 0) {
    return [""];
  }

  const widths = measureOffsets(font, paragraph);
  const wrapOffsets = findWrapOpportunities(paragraph);
  if (wrapOffsets[wrapOffsets.length - 1] !== paragraph.length) {
    wrapOffsets.push(paragraph.length);
  }
  const lines: string[] = [];
  let start = opts.preserveLeadingWhitespace ? 0 : skipLeadingWhitespace(paragraph, 0);

  while (start < paragraph.length) {
    let best = -1;
    for (const candidate of wrapOffsets) {
      if (candidate <= start) continue;
      if (measureSpan(widths, candidate) - measureSpan(widths, start) <= targetWidth) {
        best = candidate;
        continue;
      }
      break;
    }

    const splitOffset = furthestFittingOffset(widths, start, targetWidth);
    if (opts.breakLongWords && splitOffset > start && (best < 0 || splitOffset > trimEndOffset(paragraph, best))) {
      best = splitOffset;
    }
    if (best < 0) {
      best = splitOffset;
    }
    if (best <= start) {
      best = nextOffset(widths, start);
    }

    const lineEnd = trimEndOffset(paragraph, best);
    const line = paragraph.slice(start, lineEnd);
    lines.push(line);
    start = opts.preserveLeadingWhitespace && lines.length === 1 ? best : skipLeadingWhitespace(paragraph, best);
  }

  return lines.length ? lines : [""];
}

function measureOffsets(font: WrapFont, text: string): Map<number, number> {
  const widths = new Map<number, number>();
  let total = 0;
  widths.set(0, 0);
  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i) ?? 32;
    const char = String.fromCodePoint(codePoint);
    i += char.length;
    total += font.getGlyph(codePoint)?.dwidthX ?? 0;
    widths.set(i, total);
  }
  return widths;
}

function furthestFittingOffset(widths: Map<number, number>, start: number, targetWidth: number): number {
  const startWidth = measureSpan(widths, start);
  let best = start;
  for (const offset of widths.keys()) {
    if (offset <= start) continue;
    if (measureSpan(widths, offset) - startWidth <= targetWidth) {
      best = offset;
      continue;
    }
    break;
  }
  return best;
}

function nextOffset(widths: Map<number, number>, start: number): number {
  for (const offset of widths.keys()) {
    if (offset > start) return offset;
  }
  return start;
}

function measureSpan(widths: Map<number, number>, offset: number): number {
  return widths.get(offset) ?? 0;
}

function skipLeadingWhitespace(text: string, offset: number): number {
  let cursor = offset;
  while (cursor < text.length) {
    const codePoint = text.codePointAt(cursor) ?? 0;
    const char = String.fromCodePoint(codePoint);
    if (!isWhitespace(char) || char === "\n") {
      break;
    }
    cursor += char.length;
  }
  return cursor;
}

function trimEndOffset(text: string, offset: number): number {
  let cursor = offset;
  while (cursor > 0) {
    const previous = previousOffset(text, cursor);
    const char = text.slice(previous, cursor);
    if (!isWhitespace(char) || char === "\n") {
      break;
    }
    cursor = previous;
  }
  return cursor;
}

function previousOffset(text: string, offset: number): number {
  let cursor = 0;
  let previous = 0;
  while (cursor < offset) {
    previous = cursor;
    const codePoint = text.codePointAt(cursor) ?? 0;
    cursor += String.fromCodePoint(codePoint).length;
  }
  return previous;
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isBreakAfter(char: string): boolean {
  return char === "-" || char === "/" || char === "," || char === ";" || char === ":";
}
