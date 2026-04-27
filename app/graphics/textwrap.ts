import { BdfFont } from "./bdffont";

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

export function wrapText(font: BdfFont, text: string, targetWidth: number): string[] {
  if (targetWidth <= 0) {
    return text.length ? text.split("\n") : [""];
  }

  const paragraphs = text.replace(/\r/g, "").split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    lines.push(...wrapParagraph(font, paragraph, targetWidth));
  }
  return lines.length ? lines : [""];
}

function wrapParagraph(font: BdfFont, paragraph: string, targetWidth: number): string[] {
  if (paragraph.length === 0) {
    return [""];
  }

  const widths = measureOffsets(font, paragraph);
  const wrapOffsets = findWrapOpportunities(paragraph);
  const lines: string[] = [];
  let start = skipLeadingWhitespace(paragraph, 0);

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

    if (best < 0) {
      best = furthestFittingOffset(widths, start, targetWidth);
    }
    if (best <= start) {
      best = nextOffset(widths, start);
    }

    const line = paragraph.slice(start, best).trimEnd();
    lines.push(line);
    start = skipLeadingWhitespace(paragraph, best);
  }

  return lines.length ? lines : [""];
}

function measureOffsets(font: BdfFont, text: string): Map<number, number> {
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

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isBreakAfter(char: string): boolean {
  return char === "-" || char === "/" || char === "," || char === ";" || char === ":";
}
