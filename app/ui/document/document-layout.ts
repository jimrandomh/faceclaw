/**
 * Lays a DocumentRoot (document-model.ts) out into positioned lines of styled
 * text, at a given width. Pure geometry, for DocumentView to paint: fonts come
 * in through `fontFor`, so nothing here depends on the font settings.
 *
 * A line mixes fonts freely (bold runs, a heading's size), so lines size to
 * their tallest font and each segment sits on the line's shared baseline.
 */
import type { UiFont } from "../../graphics/image";
import { wrapStyledParagraph, wrapText } from "../../graphics/textwrap";
import { docNodePlainText, type DocInline, type DocNode, type DocumentRoot } from "./document-model";

/** Blank space to the right of a line's text. */
export const RIGHT_PAD = 10;
/** A code block's shading starts this far left of its text. */
export const CODE_INSET = 6;
/** Text spacing inside a line: 1px above the font's line cell, 1px below. */
const LINE_PAD = 2;

const OUTLINE_LEFT = 4;
const INDENT_STEP = 18;
const MARKER_GUTTER = 16;
const MARKER_PAD = 6;
const MIN_TEXT_WIDTH = 40;
const BLOCK_GAP = 8;
const HEADING_GAP = 14;
const QUOTE_INDENT = 14;
const QUOTE_BAR_OFFSET = 2;
const RULE_LINE_HEIGHT = 9;

export type DocFontStyle = { headingLevel?: number; bold?: boolean };

export type DocFontChooser = (style: DocFontStyle) => UiFont;

export type DocLayoutOptions = {
  width: number;
  /** Lay out as prose for reading: nothing selectable, and no gutter on unmarked text. */
  reading: boolean;
  fontFor: DocFontChooser;
};

export type DocSegment = {
  text: string;
  x: number;
  font: UiFont;
  kind: DocInline["kind"];
  bold: boolean;
  underline: boolean;
};

export type DocLine = {
  node: DocNode;
  /** Index into DocLayout.selectable, or -1 for unselectable filler. */
  selectableIndex: number;
  /** First wrapped line of its node (draws the bullet/checkbox marker). */
  firstOfNode: boolean;
  indentX: number;
  textX: number;
  height: number;
  /** Distance from the top of the line's text cell to its shared baseline. */
  ascent: number;
  /** The node's font (markers, and the line's size when it has no text). */
  font: UiFont;
  /** Line belongs to a code block (shaded background). */
  codeBlock: boolean;
  /** X positions of the block-quote bars running alongside this line. */
  quoteBars: readonly number[];
  segments: DocSegment[];
};

export type DocLayout = {
  lines: DocLine[];
  selectable: DocNode[];
};

/** Owner of paragraph-gap lines, so selection can never land on one. */
const GAP_NODE: DocNode = { id: "", kind: "text", inlines: [], children: [] };

export function layoutDocument(root: DocumentRoot, options: DocLayoutOptions): DocLayout {
  const layout: DocLayout = { lines: [], selectable: [] };
  const leftX = options.reading ? 0 : OUTLINE_LEFT;
  for (const node of root.nodes) layoutNode(node, leftX, [], layout, options);
  return layout;
}

function layoutNode(
  node: DocNode,
  leftX: number,
  quoteBars: readonly number[],
  layout: DocLayout,
  options: DocLayoutOptions,
): void {
  const { width, reading, fontFor } = options;
  const blank = (owner: DocNode, height: number): DocLine => ({
    node: owner,
    selectableIndex: -1,
    firstOfNode: false,
    indentX: leftX,
    textX: leftX,
    height,
    ascent: 0,
    font: fontFor({}),
    codeBlock: false,
    quoteBars,
    segments: [],
  });

  if (node.spaced && layout.lines.length > 0) {
    layout.lines.push(blank(GAP_NODE, node.kind === "heading" ? HEADING_GAP : BLOCK_GAP));
  }
  if (node.kind === "quote") {
    const bars = [...quoteBars, leftX + QUOTE_BAR_OFFSET];
    for (const child of node.children) layoutNode(child, leftX + QUOTE_INDENT, bars, layout, options);
    return;
  }
  if (node.kind === "rule") {
    layout.lines.push(blank(node, RULE_LINE_HEIGHT));
    return;
  }

  const font = fontFor(node.kind === "heading" ? { headingLevel: node.level ?? 1 } : {});
  const hasMarker = node.kind === "todo" || !!node.bullet || node.marker !== undefined;
  const textX = leftX + markerGutter(node, font, hasMarker, reading) + (reading && node.kind === "code" ? CODE_INSET : 0);
  const textWidth = Math.max(MIN_TEXT_WIDTH, width - textX - RIGHT_PAD);
  const plainText = docNodePlainText(node);
  const selectableIndex = !reading && plainText.trim().length > 0 ? layout.selectable.length : -1;
  if (selectableIndex >= 0) layout.selectable.push(node);

  const pushLine = (segments: DocSegment[]): void => {
    const cells = segments.length > 0 ? segments.map((segment) => segment.font) : [font];
    layout.lines.push({
      node,
      selectableIndex,
      firstOfNode: layout.lines[layout.lines.length - 1]?.node !== node,
      indentX: leftX,
      textX,
      height: Math.max(...cells.map((cell) => cell.lineHeight)) + LINE_PAD,
      ascent: Math.max(...cells.map((cell) => cell.ascent)),
      font,
      codeBlock: node.kind === "code",
      quoteBars,
      segments,
    });
  };

  if (node.kind === "code") {
    const codeLines = wrapText(font, node.codeText ?? "", textWidth - CODE_INSET, {
      preserveLeadingWhitespace: true,
      breakLongWords: true,
    });
    for (const text of codeLines) {
      pushLine([{ text, x: textX, font, kind: "text", bold: false, underline: false }]);
    }
  } else {
    const spans = inlineSpans(node, fontFor);
    // Explicit line breaks are newlines in the text; each piece wraps separately.
    let offset = 0;
    for (const paragraph of plainText.split("\n")) {
      const base = offset;
      const ranges = wrapStyledParagraph(paragraph, (index) => spanAt(spans, base + index)?.font ?? font, textWidth, {
        breakLongWords: true,
      });
      for (const range of ranges) {
        pushLine(segmentRange(spans, base + range.start, base + range.end, plainText, textX));
      }
      offset += paragraph.length + 1;
    }
  }

  // Reading layout nests under a list item's text; outlines indent a fixed step.
  const childX = reading && hasMarker ? textX : leftX + INDENT_STEP;
  for (const child of node.children) layoutNode(child, childX, quoteBars, layout, options);
}

function markerGutter(node: DocNode, font: UiFont, hasMarker: boolean, reading: boolean): number {
  if (node.marker !== undefined) {
    return Math.max(MARKER_GUTTER, Math.ceil(font.measureText(node.marker)) + MARKER_PAD);
  }
  return hasMarker || !reading ? MARKER_GUTTER : 0;
}

type InlineSpan = {
  start: number;
  end: number;
  font: UiFont;
  kind: DocInline["kind"];
  bold: boolean;
  underline: boolean;
};

function inlineSpans(node: DocNode, fontFor: DocFontChooser): InlineSpan[] {
  const headingLevel = node.kind === "heading" ? node.level ?? 1 : undefined;
  const spans: InlineSpan[] = [];
  let offset = 0;
  for (const inline of node.inlines) {
    const end = offset + inline.text.length;
    if (end > offset) {
      spans.push({
        start: offset,
        end,
        font: fontFor({ headingLevel, bold: inline.bold }),
        kind: inline.kind,
        bold: !!inline.bold,
        underline: !!inline.underline || inline.kind === "link",
      });
    }
    offset = end;
  }
  return spans;
}

function spanAt(spans: readonly InlineSpan[], offset: number): InlineSpan | undefined {
  return spans.find((span) => span.start <= offset && offset < span.end);
}

/** Split one wrapped line, plainText[start..end), at span boundaries. */
function segmentRange(
  spans: readonly InlineSpan[],
  start: number,
  end: number,
  plainText: string,
  textX: number,
): DocSegment[] {
  const segments: DocSegment[] = [];
  let x = textX;
  for (const span of spans) {
    const from = Math.max(span.start, start);
    const to = Math.min(span.end, end);
    if (from >= to) continue;
    const text = plainText.slice(from, to);
    segments.push({ text, x, font: span.font, kind: span.kind, bold: span.bold, underline: span.underline });
    x += span.font.measureText(text);
  }
  return segments;
}

/** How many lines from `start` fit in `height` (always at least one). */
export function visibleLineCount(lines: readonly DocLine[], start: number, height: number): number {
  let used = 0;
  let count = 0;
  for (let index = start; index < lines.length; index++) {
    used += lines[index]!.height;
    if (used > height) break;
    count++;
  }
  return Math.max(1, count);
}

/**
 * The line each page starts on, for a view of the given height. Consecutive
 * pages share a line, like the plain text viewer, except that no page starts
 * with a paragraph gap.
 */
export function pageStartLines(lines: readonly DocLine[], height: number): number[] {
  const starts = [0];
  let start = 0;
  for (;;) {
    const count = visibleLineCount(lines, start, height);
    if (start + count >= lines.length) return starts;
    let next = start + Math.max(1, count - 1);
    while (next < lines.length - 1 && lines[next]!.node === GAP_NODE) next++;
    starts.push(next);
    start = next;
  }
}
