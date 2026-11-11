/**
 * Renders a DocumentRoot (document-model.ts) into a scrollable, selectable
 * region: nested nodes indent, todo nodes get checkboxes, links underline,
 * code blocks get a shaded box. Selection moves over nodes (a node's wrapped
 * lines highlight as one unit) and the scroll position follows it, matching
 * the house list style in ui/menu.ts. Scrolling is by whole lines: the
 * region's top always shows the start of a line (or the padding before the
 * first one), and a line that would be cut off at its bottom is left out.
 */
import { GrayImage, type UiFont } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { wrapText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { drawListScrollbar, drawSelectionHighlight } from "../menu";
import {
  docNodePlainText,
  type DocInline,
  type DocNode,
  type DocumentRoot,
} from "./document-model";

const INDENT_STEP = 18;
const MARKER_GUTTER = 16;
const RIGHT_PAD = 10;
const CODE_INSET = 6;

/**
 * The size of the region a DocumentView scrolls in. padTop and padBottom are
 * blank space inside the scrolled content, before the first line and after
 * the last (default none), which scrolls away with the lines. A view whose
 * region runs to a window's top or bottom edge passes the padding suggested
 * for that edge (viewport.ts): its end lines then keep clear of a border
 * line there, while lines scrolled past them use the room up to the edge.
 */
export type DocumentViewSize = { width: number; height: number; padTop?: number; padBottom?: number };

type SegmentStyle = "plain" | "link" | "code";

type Segment = { text: string; x: number; style: SegmentStyle };

type LayoutLine = {
  node: DocNode;
  /** Index into the selectable-node list, or -1 for unselectable filler. */
  selectableIndex: number;
  /** First wrapped line of its node (draws the bullet/checkbox marker). */
  firstOfNode: boolean;
  indentX: number;
  textX: number;
  height: number;
  font: UiFont;
  /** Line belongs to a code block (shaded background). */
  codeBlock: boolean;
  segments: Segment[];
};

export class DocumentView {
  private root: DocumentRoot | null = null;
  private lines: LayoutLine[] = [];
  private selectable: DocNode[] = [];
  private selectedIndex = 0;
  /** Index of the line at the region's top; at 0 the top padding shows above it. */
  private scrollLine = 0;
  private width: number;
  private height: number;
  private padTop: number;
  private padBottom: number;

  constructor(size: DocumentViewSize) {
    this.width = size.width;
    this.height = size.height;
    this.padTop = size.padTop ?? 0;
    this.padBottom = size.padBottom ?? 0;
  }

  /** Re-wrap the document for a region of a new size, keeping the selection in view. */
  resize(size: DocumentViewSize): void {
    const padTop = size.padTop ?? 0;
    const padBottom = size.padBottom ?? 0;
    if (size.width === this.width && size.height === this.height && padTop === this.padTop && padBottom === this.padBottom) return;
    this.width = size.width;
    this.height = size.height;
    this.padTop = padTop;
    this.padBottom = padBottom;
    if (this.root) this.setDocument(this.root);
  }

  setDocument(root: DocumentRoot): void {
    const previousId = this.selectedNode()?.id;
    this.root = root;
    this.layout();
    if (previousId) {
      const index = this.selectable.findIndex((node) => node.id === previousId);
      if (index >= 0) this.selectedIndex = index;
    }
    this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, this.selectable.length - 1));
    this.scrollLine = clamp(this.scrollLine, 0, this.maxScrollLine());
    this.ensureSelectionVisible();
  }

  selectedNode(): DocNode | null {
    return this.selectable[this.selectedIndex] ?? null;
  }

  /** Move the selection (or just scroll, in a document with nothing selectable). */
  moveSelection(delta: number): boolean {
    if (this.selectable.length === 0) {
      return this.scrollBy(delta * 3);
    }
    const next = clamp(this.selectedIndex + delta, 0, this.selectable.length - 1);
    if (next === this.selectedIndex) return false;
    this.selectedIndex = next;
    this.ensureSelectionVisible();
    return true;
  }

  scrollBy(deltaLines: number): boolean {
    const next = clamp(this.scrollLine + deltaLines, 0, this.maxScrollLine());
    if (next === this.scrollLine) return false;
    this.scrollLine = next;
    return true;
  }

  /** Draw the document region onto `target` with its top-left at (x, y). */
  paint(target: GrayImage, x: number, y: number, focused: boolean): void {
    const image = new GrayImage(this.width, this.height, 0);
    const selected = this.selectedNode();
    const firstLineY = this.leadAt(this.scrollLine);
    const visibleCount = this.visibleCountFrom(this.scrollLine);
    const lastVisible = Math.min(this.lines.length, this.scrollLine + visibleCount);

    // Selection highlight behind the selected node's visible lines.
    if (selected) {
      let top: number | null = null;
      let bottom = 0;
      let indentX = 0;
      let lineY = firstLineY;
      for (let index = this.scrollLine; index < lastVisible; index++) {
        const line = this.lines[index]!;
        if (line.node === selected) {
          if (top === null) {
            top = lineY;
            indentX = line.indentX;
          }
          bottom = lineY + line.height;
        }
        lineY += line.height;
      }
      if (top !== null) {
        const highlightX = Math.max(0, indentX - 4);
        drawSelectionHighlight(image, highlightX, top, this.width - highlightX - RIGHT_PAD + 4, bottom - top, focused, 4);
      }
    }

    let lineY = firstLineY;
    for (let index = this.scrollLine; index < lastVisible; index++) {
      const line = this.lines[index]!;
      const isSelected = line.node === selected;
      if (line.codeBlock) {
        image.fillRect(line.textX - CODE_INSET, lineY, this.width - line.textX - RIGHT_PAD + CODE_INSET, line.height, 16);
        image.drawLine(line.textX - CODE_INSET, lineY, line.textX - CODE_INSET, lineY + line.height - 1, 70);
      }
      if (line.firstOfNode) this.drawMarker(image, line, lineY);
      for (const segment of line.segments) {
        this.drawSegment(image, line, segment, lineY, isSelected);
      }
      lineY += line.height;
    }

    if (this.lines.length > visibleCount) {
      // The track keeps inside the padding, as the document's end lines do.
      const trackHeight = Math.max(0, this.height - this.padTop - this.padBottom);
      drawListScrollbar(image, this.width - 3, this.padTop, trackHeight, this.scrollLine, visibleCount, this.lines.length);
    }
    target.bitBlt(image, x, y);
  }

  private drawMarker(image: GrayImage, line: LayoutLine, lineY: number): void {
    const node = line.node;
    if (node.kind === "todo") {
      const boxY = lineY + Math.max(0, Math.floor((line.height - 10) / 2)) - 1;
      image.drawRect(line.indentX, boxY, 10, 10, 170);
      if (node.checked) {
        image.drawLine(line.indentX + 2, boxY + 5, line.indentX + 4, boxY + 7, 220);
        image.drawLine(line.indentX + 4, boxY + 7, line.indentX + 8, boxY + 2, 220);
      }
    } else if (node.kind !== "heading" && node.kind !== "code" && node.bullet) {
      const dotY = lineY + Math.floor(line.height / 2) - 1;
      image.fillRect(line.indentX + 4, dotY, 3, 3, 130);
    }
  }

  private drawSegment(image: GrayImage, line: LayoutLine, segment: Segment, lineY: number, selected: boolean): void {
    const node = line.node;
    const width = line.font.measureText(segment.text);
    let value: number;
    if (node.kind === "heading") {
      value = 225;
    } else if (node.kind === "todo" && node.checked) {
      value = 110;
    } else if (line.codeBlock) {
      value = 185;
    } else if (segment.style === "link") {
      value = 220;
    } else {
      value = 195;
    }
    if (selected) value = Math.min(250, value + 40);
    if (segment.style === "code" && !line.codeBlock) {
      image.fillRect(segment.x - 1, lineY, width + 2, line.height, 25);
    }
    image.drawText(line.font, segment.x, lineY + 1, segment.text, value);
    if (segment.style === "link" && width > 0) {
      image.drawLine(segment.x, lineY + line.height - 2, segment.x + width - 1, lineY + line.height - 2, node.kind === "todo" && node.checked ? 70 : 120);
    }
  }

  // -------------------------------------------------------------------------
  // Layout

  private layout(): void {
    this.lines = [];
    this.selectable = [];
    if (!this.root) return;
    for (const node of this.root.nodes) this.layoutNode(node, 0);
  }

  private layoutNode(node: DocNode, depth: number): void {
    const font = node.kind === "heading" ? getDefaultMediumFont() : getDefaultSmallFont();
    const lineHeight = font.lineHeight + 2;
    const indentX = 4 + depth * INDENT_STEP;
    const textX = indentX + MARKER_GUTTER;
    const textWidth = Math.max(40, this.width - textX - RIGHT_PAD);
    const plainText = docNodePlainText(node);
    const selectableIndex = plainText.trim().length > 0 ? this.selectable.length : -1;
    if (selectableIndex >= 0) this.selectable.push(node);

    const base = {
      node,
      selectableIndex,
      indentX,
      textX,
      height: lineHeight,
      font,
      codeBlock: node.kind === "code",
    };

    if (node.kind === "code") {
      const codeLines = wrapText(font, node.codeText ?? "", textWidth - CODE_INSET, {
        preserveLeadingWhitespace: true,
        breakLongWords: true,
      });
      codeLines.forEach((text, index) => {
        this.lines.push({
          ...base,
          firstOfNode: index === 0,
          segments: [{ text, x: textX, style: "plain" }],
        });
      });
    } else if (plainText.length === 0) {
      this.lines.push({ ...base, firstOfNode: true, segments: [] });
    } else {
      const wrapped = wrapText(font, plainText, textWidth, { breakLongWords: true });
      const spans = inlineSpans(node.inlines);
      let cursor = 0;
      wrapped.forEach((text, index) => {
        let start = cursor;
        if (text.length > 0) {
          const found = plainText.indexOf(text, cursor);
          start = found >= 0 ? found : cursor;
          cursor = start + text.length;
        }
        this.lines.push({
          ...base,
          firstOfNode: index === 0,
          segments: segmentLine(font, text, start, spans, textX),
        });
      });
    }

    for (const child of node.children) this.layoutNode(child, depth + 1);
  }

  // -------------------------------------------------------------------------
  // Scrolling

  /** Blank space above the line at the region's top: the top padding, until it scrolls away. */
  private leadAt(scrollLine: number): number {
    return scrollLine === 0 ? this.padTop : 0;
  }

  /** How many whole lines the region shows when scrolled to `start` (never fewer than one). */
  private visibleCountFrom(start: number): number {
    let used = this.leadAt(start);
    let count = 0;
    for (let index = start; index < this.lines.length; index++) {
      used += this.lines[index]!.height;
      if (used > this.height) break;
      count++;
    }
    return Math.max(1, count);
  }

  /**
   * Whether the region, scrolled to `start`, shows the lines through `end`
   * whole, and after the document's last line the bottom padding too.
   */
  private showsThrough(start: number, end: number): boolean {
    let used = this.leadAt(start) + (end === this.lines.length - 1 ? this.padBottom : 0);
    for (let index = start; index <= end && used <= this.height; index++) used += this.lines[index]!.height;
    return used <= this.height;
  }

  /** The furthest the view scrolls: the first line from which the rest fits, bottom padding included. */
  private maxScrollLine(): number {
    let used = this.padBottom;
    for (let index = this.lines.length - 1; index >= 0; index--) {
      used += this.lines[index]!.height;
      if (used + this.leadAt(index) > this.height) return Math.min(index + 1, this.lines.length - 1);
    }
    return 0;
  }

  private ensureSelectionVisible(): void {
    const selected = this.selectedNode();
    if (!selected) return;
    let first = -1;
    let last = -1;
    for (let index = 0; index < this.lines.length; index++) {
      if (this.lines[index]!.node === selected) {
        if (first < 0) first = index;
        last = index;
      }
    }
    if (first < 0) return;
    // Lines no selection reaches belong with the end node next to them:
    // selecting the first node shows the document's start, and the last its
    // end, with the padding there, when that fits along with the node.
    const end = this.lines.length - 1;
    if (this.selectedIndex === 0 && this.showsThrough(0, last)) first = 0;
    if (this.selectedIndex === this.selectable.length - 1 && this.showsThrough(first, end)) last = end;
    let scroll = this.scrollLine;
    // Scroll down the minimum needed; a node taller than the view pins its top.
    while (scroll < first && !this.showsThrough(scroll, last)) scroll++;
    if (first < scroll) scroll = first;
    this.scrollLine = clamp(scroll, 0, this.maxScrollLine());
  }
}

type InlineSpan = { start: number; end: number; style: SegmentStyle };

function inlineSpans(inlines: readonly DocInline[]): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let offset = 0;
  for (const inline of inlines) {
    const end = offset + inline.text.length;
    const style: SegmentStyle = inline.kind === "link" ? "link" : inline.kind === "code" ? "code" : "plain";
    if (inline.text.length > 0) spans.push({ start: offset, end, style });
    offset = end;
  }
  return spans;
}

/** Split one wrapped line (plainText[start..start+text.length)) at span boundaries. */
function segmentLine(
  font: UiFont,
  text: string,
  start: number,
  spans: readonly InlineSpan[],
  textX: number,
): Segment[] {
  if (text.length === 0) return [];
  const end = start + text.length;
  const segments: Segment[] = [];
  let x = textX;
  let cursor = start;
  while (cursor < end) {
    const span = spans.find((candidate) => candidate.start <= cursor && cursor < candidate.end);
    const spanEnd = span ? Math.min(span.end, end) : nextSpanStart(spans, cursor, end);
    const piece = text.slice(cursor - start, spanEnd - start);
    segments.push({ text: piece, x, style: span?.style ?? "plain" });
    x += font.measureText(piece);
    cursor = spanEnd;
  }
  return segments;
}

function nextSpanStart(spans: readonly InlineSpan[], cursor: number, end: number): number {
  let next = end;
  for (const span of spans) {
    if (span.start > cursor && span.start < next) next = span.start;
  }
  return next;
}
