/**
 * Renders a DocumentRoot (document-model.ts), as laid out by document-layout.ts,
 * into a scrollable region: nested nodes indent, todo nodes get checkboxes,
 * links and underlined text underline, bold text draws in a heavier weight,
 * headings draw larger, code blocks get a shaded box, block quotes get a
 * vertical bar.
 *
 * Two modes. As an outline (the default), selection moves over nodes (a node's
 * wrapped lines highlight as one unit) and the scroll position follows it,
 * matching the house list style in ui/menu.ts. As a reader, nothing is
 * selectable and the document turns a page at a time (pageBy).
 */
import { GrayImage, type UiFont } from "../../graphics/image";
import { getDefaultSmallFont, uiFontVariant } from "../../graphics/ui-fonts";
import { clamp } from "../../util/numeric-util";
import { drawListScrollbar, drawSelectionHighlight } from "../menu";
import type { DocNode, DocumentRoot } from "./document-model";
import {
  CODE_INSET,
  layoutDocument,
  pageStartLines,
  RIGHT_PAD,
  visibleLineCount,
  type DocFontStyle,
  type DocLine,
  type DocSegment,
} from "./document-layout";

/** Heading size relative to body text, for levels 1, 2, 3; deeper levels are body-sized. */
const HEADING_SCALES = [1.5, 1.3, 1.15];

const QUOTE_BAR_WIDTH = 2;
const QUOTE_BAR_VALUE = 130;
const RULE_VALUE = 100;

/** All document fonts derive from the UI font; headings are always bold. */
function documentFont(style: DocFontStyle): UiFont {
  const base = getDefaultSmallFont();
  if (style.headingLevel !== undefined) {
    return uiFontVariant(base, HEADING_SCALES[style.headingLevel - 1] ?? 1, true);
  }
  return style.bold ? uiFontVariant(base, 1, true) : base;
}

export type DocumentViewOptions = {
  /** Read-only paged prose: no selection, no scrollbar, and turn pages with pageBy. */
  reading?: boolean;
};

export class DocumentView {
  private root: DocumentRoot | null = null;
  private lines: DocLine[] = [];
  private selectable: DocNode[] = [];
  private selectedIndex = 0;
  private scrollLine = 0;
  /** The UI font the current layout was made with. */
  private layoutFontId = 0;
  /** Lazily computed for the current layout and size (reading mode). */
  private pageStarts: number[] | null = null;
  private readonly reading: boolean;

  constructor(
    private width: number,
    private height: number,
    options: DocumentViewOptions = {},
  ) {
    this.reading = !!options.reading;
  }

  /** Re-wrap the document for a region of a new size, keeping the selection in view. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
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
    if (this.reading) {
      const starts = this.getPageStarts();
      this.scrollLine = starts[this.pageIndexOf(this.scrollLine, starts)]!;
    } else {
      this.scrollLine = clamp(this.scrollLine, 0, this.maxScrollLine());
    }
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

  /** Turn pages (reading mode). False when already at that end of the document. */
  pageBy(delta: number): boolean {
    const starts = this.getPageStarts();
    const next = clamp(this.pageIndexOf(this.scrollLine, starts) + delta, 0, starts.length - 1);
    if (starts[next] === this.scrollLine) return false;
    this.scrollLine = starts[next]!;
    return true;
  }

  /** The current 1-based page and the page count (reading mode). */
  pagePosition(): { page: number; pageCount: number } {
    const starts = this.getPageStarts();
    return { page: this.pageIndexOf(this.scrollLine, starts) + 1, pageCount: starts.length };
  }

  /** Draw the document region onto `target` with its top-left at (x, y). */
  paint(target: GrayImage, x: number, y: number, focused: boolean): void {
    // A font change (Settings is reachable with a document open) needs a re-wrap.
    if (this.root && getDefaultSmallFont().fingerprintId !== this.layoutFontId) this.setDocument(this.root);
    const image = new GrayImage(this.width, this.height, 0);
    const selected = this.selectedNode();
    const visibleCount = this.visibleCountFrom(this.scrollLine);
    const lastVisible = Math.min(this.lines.length, this.scrollLine + visibleCount);

    // Selection highlight behind the selected node's visible lines.
    if (selected) {
      let top: number | null = null;
      let bottom = 0;
      let indentX = 0;
      let lineY = 0;
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

    let lineY = 0;
    for (let index = this.scrollLine; index < lastVisible; index++) {
      const line = this.lines[index]!;
      const isSelected = line.node === selected;
      if (line.codeBlock) {
        image.fillRect(line.textX - CODE_INSET, lineY, this.width - line.textX - RIGHT_PAD + CODE_INSET, line.height, 16);
        image.drawLine(line.textX - CODE_INSET, lineY, line.textX - CODE_INSET, lineY + line.height - 1, 70);
      }
      for (const barX of line.quoteBars) {
        image.fillRect(barX, lineY, QUOTE_BAR_WIDTH, line.height, QUOTE_BAR_VALUE);
      }
      if (line.node.kind === "rule") {
        image.fillRect(line.indentX, lineY + Math.floor(line.height / 2), this.width - line.indentX - RIGHT_PAD, 1, RULE_VALUE);
      }
      if (line.firstOfNode) this.drawMarker(image, line, lineY);
      for (const segment of line.segments) {
        this.drawSegment(image, line, segment, lineY, isSelected);
      }
      lineY += line.height;
    }

    if (!this.reading && this.lines.length > visibleCount) {
      drawListScrollbar(image, this.width - 3, 0, this.height, this.scrollLine, visibleCount, this.lines.length);
    }
    target.bitBlt(image, x, y);
  }

  private drawMarker(image: GrayImage, line: DocLine, lineY: number): void {
    const node = line.node;
    if (node.kind === "todo") {
      const boxY = lineY + Math.max(0, Math.floor((line.height - 10) / 2)) - 1;
      image.drawRect(line.indentX, boxY, 10, 10, 170);
      if (node.checked) {
        image.drawLine(line.indentX + 2, boxY + 5, line.indentX + 4, boxY + 7, 220);
        image.drawLine(line.indentX + 4, boxY + 7, line.indentX + 8, boxY + 2, 220);
      }
    } else if (node.marker !== undefined) {
      image.drawText(line.font, line.indentX, lineY + 1 + line.ascent - line.font.ascent, node.marker, 170);
    } else if (node.kind !== "heading" && node.kind !== "code" && node.bullet) {
      const dotY = lineY + Math.floor(line.height / 2) - 1;
      image.fillRect(line.indentX + 4, dotY, 3, 3, 130);
    }
  }

  private segmentValue(line: DocLine, segment: DocSegment, selected: boolean): number {
    const node = line.node;
    if (node.kind === "todo" && node.checked) return selected ? 150 : 110;
    if (this.reading) {
      if (node.kind === "heading" || segment.bold) return 255;
      return line.codeBlock ? 200 : 230;
    }
    let value: number;
    if (node.kind === "heading") {
      value = 225;
    } else if (line.codeBlock) {
      value = 185;
    } else if (segment.kind === "link" || segment.bold) {
      value = 220;
    } else {
      value = 195;
    }
    return selected ? Math.min(250, value + 40) : value;
  }

  private drawSegment(image: GrayImage, line: DocLine, segment: DocSegment, lineY: number, selected: boolean): void {
    const { font } = segment;
    const width = font.measureText(segment.text);
    const textY = lineY + 1 + line.ascent - font.ascent;
    if (segment.kind === "code" && !line.codeBlock) {
      image.fillRect(segment.x - 1, lineY, width + 2, line.height, 25);
    }
    image.drawText(font, segment.x, textY, segment.text, this.segmentValue(line, segment, selected));
    if (segment.underline && width > 0) {
      const underlineY = textY + font.ascent + Math.max(1, font.descent - 1);
      const dimmed = line.node.kind === "todo" && line.node.checked;
      image.drawLine(segment.x, underlineY, segment.x + width - 1, underlineY, dimmed ? 70 : this.reading ? 170 : 120);
    }
  }

  // -------------------------------------------------------------------------
  // Layout

  private layout(): void {
    this.pageStarts = null;
    this.layoutFontId = getDefaultSmallFont().fingerprintId;
    if (!this.root) {
      this.lines = [];
      this.selectable = [];
      return;
    }
    const layout = layoutDocument(this.root, { width: this.width, reading: this.reading, fontFor: documentFont });
    this.lines = layout.lines;
    this.selectable = layout.selectable;
  }

  private getPageStarts(): number[] {
    this.pageStarts ??= pageStartLines(this.lines, this.height);
    return this.pageStarts;
  }

  /** The page showing `line`: the last page starting at or before it. */
  private pageIndexOf(line: number, starts: readonly number[]): number {
    let page = 0;
    while (page + 1 < starts.length && starts[page + 1]! <= line) page++;
    return page;
  }

  // -------------------------------------------------------------------------
  // Scrolling

  private visibleCountFrom(start: number): number {
    return visibleLineCount(this.lines, start, this.height);
  }

  private maxScrollLine(): number {
    let used = 0;
    for (let index = this.lines.length - 1; index >= 0; index--) {
      used += this.lines[index]!.height;
      if (used > this.height) return index + 1;
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
    let scroll = this.scrollLine;
    // Scroll down the minimum needed; a node taller than the view pins its top.
    while (last >= scroll + this.visibleCountFrom(scroll) && scroll < first) scroll++;
    if (first < scroll) scroll = first;
    this.scrollLine = clamp(scroll, 0, this.maxScrollLine());
  }
}
