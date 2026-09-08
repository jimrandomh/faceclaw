/**
 * What wrapping and truncation need from a font. BdfFont and TtfFont both
 * satisfy it structurally. Wrapping and truncation use the same measured
 * widths as rendering, including fractional advances and kerning.
 */
export interface WrapFont {
  measureText(text: string): number;
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
  return truncateMeasured(font, text, maxWidth, false);
}

export function truncateLeft(font: WrapFont, text: string, maxWidth: number): string {
  return truncateMeasured(font, text, maxWidth, true);
}

/** Keep complete codepoints and include the marker in the measured budget. */
function truncateMeasured(font: WrapFont, text: string, maxWidth: number, fromLeft: boolean): string {
  if (!(maxWidth > 0)) return "";
  if (font.measureText(text) <= maxWidth) return text;
  let marker = "...";
  while (marker && font.measureText(marker) > maxWidth) marker = marker.slice(1);
  if (marker.length < 3) return marker;
  const characters = Array.from(text);
  const candidate = (count: number) => fromLeft
    ? marker + characters.slice(characters.length - count).join("")
    : characters.slice(0, count).join("") + marker;
  let low = 0, high = characters.length - 1, best = 0;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (font.measureText(candidate(mid)) <= maxWidth) { best = mid; low = mid + 1; }
    else high = mid - 1;
  }
  return candidate(best);
}

function wrapParagraph(font: WrapFont, paragraph: string, targetWidth: number, opts: WrapTextOptions): string[] {
  if (paragraph.length === 0) {
    return [""];
  }

  const offsets = codePointOffsets(paragraph);
  const spanWidth = (start: number, end: number) => font.measureText(paragraph.slice(start, end));
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
      if (spanWidth(start, trimEndOffset(paragraph, candidate)) <= targetWidth) {
        best = candidate;
        continue;
      }
      break;
    }

    // Whole words already fit in the common case. Only probe character
    // boundaries for an overlong word or an explicit hard-wrap request.
    if (best < 0 || opts.breakLongWords) {
      const splitOffset = furthestMeasuredOffset(offsets, start, targetWidth, spanWidth);
      if (best < 0 || splitOffset > trimEndOffset(paragraph, best)) best = splitOffset;
    }
    if (best <= start) {
      best = nextOffset(offsets, start);
    }

    const lineEnd = trimEndOffset(paragraph, best);
    const line = paragraph.slice(start, lineEnd);
    lines.push(line);
    start = opts.preserveLeadingWhitespace && lines.length === 1 ? best : skipLeadingWhitespace(paragraph, best);
  }

  return lines.length ? lines : [""];
}

function codePointOffsets(text: string): number[] {
  const offsets = [0];
  let offset = 0;
  for (const character of text) {
    offset += character.length;
    offsets.push(offset);
  }
  return offsets;
}

function furthestMeasuredOffset(boundaries: number[], start: number, targetWidth: number, measure: (start: number, end: number) => number): number {
  const offsets = boundaries.filter(offset => offset > start);
  let low = 0;
  let high = offsets.length - 1;
  let best = start;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const end = offsets[mid]!;
    if (measure(start, end) <= targetWidth) { best = end; low = mid + 1; }
    else high = mid - 1;
  }
  return best;
}

function nextOffset(offsets: number[], start: number): number {
  return offsets.find(offset => offset > start) ?? start;
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
  let previous = Math.max(0, offset - 1);
  const low = text.charCodeAt(previous);
  if (previous > 0 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(previous - 1);
    if (high >= 0xd800 && high <= 0xdbff) previous--;
  }
  return previous;
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isBreakAfter(char: string): boolean {
  return char === "-" || char === "/" || char === "," || char === ";" || char === ":";
}
