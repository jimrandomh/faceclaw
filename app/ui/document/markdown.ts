/**
 * Parses Markdown into the shared document model (document-model.ts), for
 * DocumentView to render. Pure text-to-tree, so anything that shows text can
 * use it.
 *
 * Block syntax: ATX and setext headings, paragraphs, block quotes, bullet /
 * ordered / task lists, fenced and indented code, thematic breaks, GFM tables
 * (drawn as one wrapped line of text per row, since columns rarely fit).
 *
 * Inline syntax: emphasis, `code spans`, [links](url), [reference][links],
 * <autolinks>, bare URLs, backslash escapes and hard line breaks. Images have
 * no way to draw inline, so they become a text placeholder with their alt text.
 *
 * The one deliberate departure from CommonMark is emphasis: the glasses have
 * no italics, so *x* and **x** are both bold, and _x_ and __x__ are both
 * underlined. Which delimiters count as emphasis still follows CommonMark's
 * flanking rules, so snake_case_names and "2 * 3 * 4" stay literal.
 *
 * Not handled, and shown literally: raw HTML, HTML entities, ~~strikethrough~~.
 */
import { LETTER_CLASS, NUMBER_CLASS } from "../../util/unicode-class";
import type { DocInline, DocNode, DocNodeKind, DocumentRoot } from "./document-model";

type ParseContext = {
  /** Link reference definitions, keyed by normalizeLabel. */
  references: Map<string, string>;
  nextId: () => string;
};

/** A parsed block and the index of the first line after it. */
type BlockResult = { nodes: DocNode[]; next: number };

export function parseMarkdown(source: string, title = ""): DocumentRoot {
  const lines = source
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("\n");
  let serial = 0;
  const references = new Map<string, string>();
  const ctx: ParseContext = { references, nextId: () => `md-${serial++}` };
  return { title, nodes: parseBlocks(collectLinkReferences(lines, references), ctx) };
}

// ---------------------------------------------------------------------------
// Blocks

const BLANK = /^\s*$/;
const INDENTED_CODE = /^ {4}/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?: +(.*))?$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+) *$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:( +)(.*))?$/;
const TASK_MARKER = /^\[([ xX])\] +/;
const TABLE_DELIMITER = /^ {0,3}\|?(?: *:?-+:? *\|)* *:?-+:? *\|? *$/;
const LINK_REFERENCE = /^ {0,3}\[(?!\^)([^\]]+)\]: *(?:<([^>]*)>|(\S+))(?: +(?:"[^"]*"|'[^']*'|\([^)]*\)))? *$/;

/** Pull out `[label]: url` definitions (first wins), returning the remaining lines. */
function collectLinkReferences(lines: readonly string[], references: Map<string, string>): string[] {
  const remaining: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const definition = inFence ? null : LINK_REFERENCE.exec(line);
    if (!definition) {
      remaining.push(line);
      continue;
    }
    const label = normalizeLabel(definition[1]!);
    if (!references.has(label)) references.set(label, definition[2] ?? definition[3] ?? "");
  }
  return remaining;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function blockNode(ctx: ParseContext, kind: DocNodeKind, fields: Partial<DocNode> = {}): DocNode {
  return { id: ctx.nextId(), kind, inlines: [], children: [], ...fields };
}

function parseBlocks(lines: readonly string[], ctx: ParseContext): DocNode[] {
  const nodes: DocNode[] = [];
  let index = 0;
  while (index < lines.length) {
    if (BLANK.test(lines[index]!)) {
      index++;
      continue;
    }
    const block =
      parseIndentedCode(lines, index, ctx) ??
      parseFencedCode(lines, index, ctx) ??
      parseAtxHeading(lines, index, ctx) ??
      parseThematicBreak(lines, index, ctx) ??
      parseQuote(lines, index, ctx) ??
      parseList(lines, index, ctx) ??
      parseTable(lines, index, ctx) ??
      parseParagraph(lines, index, ctx);
    if (block.nodes.length > 0 && nodes.length > 0) block.nodes[0]!.spaced = true;
    nodes.push(...block.nodes);
    index = block.next;
  }
  return nodes;
}

function parseIndentedCode(lines: readonly string[], start: number, ctx: ParseContext): BlockResult | null {
  if (!INDENTED_CODE.test(lines[start]!)) return null;
  const code: string[] = [];
  let index = start;
  while (index < lines.length && (INDENTED_CODE.test(lines[index]!) || BLANK.test(lines[index]!))) {
    code.push(lines[index]!.slice(4));
    index++;
  }
  while (code.length > 0 && BLANK.test(code[code.length - 1]!)) code.pop();
  return { nodes: [blockNode(ctx, "code", { codeText: code.join("\n") })], next: index };
}

/** The opening fence on this line (a backtick fence's info string can't hold backticks). */
function matchFence(line: string): { indent: number; fence: string } | null {
  const match = FENCE.exec(line);
  if (!match || (match[2]![0] === "`" && match[3]!.includes("`"))) return null;
  return { indent: match[1]!.length, fence: match[2]! };
}

function parseFencedCode(lines: readonly string[], start: number, ctx: ParseContext): BlockResult | null {
  const open = matchFence(lines[start]!);
  if (!open) return null;
  const code: string[] = [];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index]!;
    index++;
    const close = /^ {0,3}(`{3,}|~{3,}) *$/.exec(line);
    if (close && close[1]![0] === open.fence[0] && close[1]!.length >= open.fence.length) break;
    code.push(line.slice(Math.min(open.indent, indentOf(line))));
  }
  return { nodes: [blockNode(ctx, "code", { codeText: code.join("\n") })], next: index };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function headingNode(level: number, text: string, ctx: ParseContext): DocNode {
  return blockNode(ctx, "heading", { level, inlines: parseInlines(text, ctx) });
}

function parseAtxHeading(lines: readonly string[], start: number, ctx: ParseContext): BlockResult | null {
  const match = ATX_HEADING.exec(lines[start]!);
  if (!match) return null;
  // A closing run of #s, set off by a space, isn't part of the title.
  const text = (match[2] ?? "").replace(/(^|\s+)#+\s*$/, "").trim();
  return { nodes: [headingNode(match[1]!.length, text, ctx)], next: start + 1 };
}

function parseThematicBreak(lines: readonly string[], start: number, ctx: ParseContext): BlockResult | null {
  if (!THEMATIC_BREAK.test(lines[start]!)) return null;
  return { nodes: [blockNode(ctx, "rule")], next: start + 1 };
}

/** Whether this line ends a paragraph rather than continuing it. */
function interruptsParagraph(line: string): boolean {
  if (ATX_HEADING.test(line) || matchFence(line) || THEMATIC_BREAK.test(line) || QUOTE.test(line)) return true;
  const item = LIST_ITEM.exec(line);
  if (!item || BLANK.test(item[4] ?? "")) return false;
  // Only a list starting at 1 interrupts, so a wrapped line that happens to
  // start "1986. A great year" stays in its paragraph.
  return !/\d/.test(item[2]![0]!) || parseInt(item[2]!, 10) === 1;
}

function parseQuote(lines: readonly string[], start: number, ctx: ParseContext): BlockResult | null {
  if (!QUOTE.test(lines[start]!)) return null;
  const inner: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    const match = QUOTE.exec(line);
    if (match) {
      inner.push(match[1]!);
    } else if (BLANK.test(line) || BLANK.test(inner[inner.length - 1]!) || interruptsParagraph(line)) {
      break;
    } else {
      inner.push(line); // lazy continuation of a quoted paragraph
    }
    index++;
  }
  return { nodes: [blockNode(ctx, "quote", { children: parseBlocks(inner, ctx) })], next: index };
}

function parseList(lines: readonly string[], start: number, ctx: ParseContext): BlockResult | null {
  const first = LIST_ITEM.exec(lines[start]!);
  if (!first) return null;
  // Items of one list share a marker character ("-", "*", "+", "." or ")").
  const listType = first[2]!.slice(-1);
  const ordered = listType === "." || listType === ")";
  let number = ordered ? parseInt(first[2]!, 10) : 0;
  const items: { lines: string[]; marker?: string }[] = [];
  let loose = false;
  let index = start;
  while (index < lines.length) {
    const item = LIST_ITEM.exec(lines[index]!);
    if (!item || item[2]!.slice(-1) !== listType || THEMATIC_BREAK.test(lines[index]!)) break;
    const collected = collectListItemLines(lines, index, item);
    index = collected.next;
    items.push({ lines: collected.lines, marker: ordered ? `${number++}${listType}` : undefined });
    const nextIsSibling = index < lines.length && LIST_ITEM.exec(lines[index]!)?.[2]!.slice(-1) === listType;
    if (collected.endedBlank && nextIsSibling) loose = true;
  }
  const nodes = items.map((item, itemIndex) => {
    const node = listItemNode(item.lines, item.marker, loose, ctx);
    if (loose && itemIndex > 0) node.spaced = true;
    return node;
  });
  return { nodes, next: index };
}

/** One list item's lines with its marker and content indent removed. */
function collectListItemLines(
  lines: readonly string[],
  start: number,
  item: RegExpExecArray,
): { lines: string[]; next: number; endedBlank: boolean } {
  const gap = item[3]?.length ?? 0;
  const rest = item[4] ?? "";
  // Content starts after the marker's spaces, except that a very wide gap (or
  // an empty first line) means one space, leaving the remainder as indentation.
  const narrowGap = gap >= 1 && gap <= 4 && rest.length > 0;
  const contentIndent = item[1]!.length + item[2]!.length + (narrowGap ? gap : 1);
  const collected = [narrowGap ? rest : " ".repeat(Math.max(0, gap - 1)) + rest];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index]!;
    if (BLANK.test(line)) {
      collected.push("");
    } else if (indentOf(line) >= contentIndent) {
      collected.push(line.slice(contentIndent));
    } else if (!BLANK.test(collected[collected.length - 1]!) && !interruptsParagraph(line) && !LIST_ITEM.test(line)) {
      collected.push(line.trimStart()); // lazy continuation of the item's paragraph
    } else {
      break;
    }
    index++;
  }
  let endedBlank = false;
  while (collected.length > 1 && BLANK.test(collected[collected.length - 1]!)) {
    collected.pop();
    endedBlank = true;
  }
  return { lines: collected, next: index, endedBlank };
}

function isListItemNode(node: DocNode): boolean {
  return node.kind === "todo" || !!node.bullet || node.marker !== undefined;
}

function listItemNode(lines: readonly string[], marker: string | undefined, loose: boolean, ctx: ParseContext): DocNode {
  const task = TASK_MARKER.exec(lines[0]!);
  const content = task ? [lines[0]!.slice(task[0].length), ...lines.slice(1)] : lines;
  const children = parseBlocks(content, ctx);
  // The item's own text is its leading paragraph; anything after nests under it.
  const lead = children[0];
  const hasLeadParagraph = lead !== undefined && lead.kind === "text" && !isListItemNode(lead);
  const inlines = hasLeadParagraph ? lead.inlines : [];
  if (hasLeadParagraph) children.shift();
  const nestedFirst = children[0];
  if (nestedFirst && !loose && isListItemNode(nestedFirst)) nestedFirst.spaced = false;
  if (task) {
    return blockNode(ctx, "todo", { checked: task[1] !== " ", inlines, children });
  }
  return blockNode(ctx, "text", marker !== undefined ? { marker, inlines, children } : { bullet: true, inlines, children });
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const delimiter = lines[index + 1];
  return (
    delimiter !== undefined &&
    lines[index]!.includes("|") &&
    delimiter.includes("|") &&
    TABLE_DELIMITER.test(delimiter)
  );
}

function parseTable(lines: readonly string[], start: number, ctx: ParseContext): BlockResult | null {
  if (!isTableStart(lines, start)) return null;
  const rows = [tableRowNode(lines[start]!, true, ctx)];
  let index = start + 2;
  while (index < lines.length && !BLANK.test(lines[index]!) && !interruptsParagraph(lines[index]!)) {
    rows.push(tableRowNode(lines[index]!, false, ctx));
    index++;
  }
  return { nodes: rows, next: index };
}

function tableRowNode(row: string, header: boolean, ctx: ParseContext): DocNode {
  let text = row.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const inlines: DocInline[] = [];
  text.split(/(?<!\\)\|/).forEach((cell, index) => {
    if (index > 0) inlines.push({ kind: "text", text: " | " });
    inlines.push(...parseInlines(cell.trim(), ctx));
  });
  return blockNode(ctx, "text", {
    inlines: header ? inlines.map((inline) => ({ ...inline, bold: true })) : inlines,
  });
}

function parseParagraph(lines: readonly string[], start: number, ctx: ParseContext): BlockResult {
  const parts = [lines[start]!];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index]!;
    if (BLANK.test(line)) break;
    const setext = SETEXT_UNDERLINE.exec(line);
    if (setext) {
      return { nodes: [headingNode(setext[1]![0] === "=" ? 1 : 2, joinParagraphLines(parts), ctx)], next: index + 1 };
    }
    if (interruptsParagraph(line) || isTableStart(lines, index)) break;
    parts.push(line);
    index++;
  }
  return { nodes: [blockNode(ctx, "text", { inlines: parseInlines(joinParagraphLines(parts), ctx) })], next: index };
}

/** Soft line breaks become spaces; two trailing spaces or a backslash force a break. */
function joinParagraphLines(lines: readonly string[]): string {
  let out = "";
  lines.forEach((line, index) => {
    const text = line.trimStart();
    if (index === lines.length - 1) {
      out += text.trimEnd();
    } else if (/( {2,}|\\)$/.test(text)) {
      out += `${text.replace(/( +|\\)$/, "")}\n`;
    } else {
      out += `${text.trimEnd()} `;
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Inlines

/** A run of * or _, which resolveEmphasis turns into styling or literal text. */
type DelimiterToken = {
  kind: "delimiter";
  char: "*" | "_";
  /** Characters not yet consumed by a matched pair. */
  count: number;
  /** Length of the run as written (for CommonMark's "rule of 3"). */
  original: number;
  canOpen: boolean;
  canClose: boolean;
  bold?: boolean;
  underline?: boolean;
};

type InlineToken = DocInline | DelimiterToken;

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
/** Tested only on non-space characters, it means CommonMark's "punctuation or symbol". */
const NOT_LETTER_OR_NUMBER = new RegExp(`[^${LETTER_CLASS}${NUMBER_CLASS}]`);
const AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/y;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<\]]+/y;
/** "(url)" or "(url "title")" directly after a link's closing bracket. */
const LINK_TAIL = /\( *(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*))(?: +(?:"[^"]*"|'[^']*'|\([^)]*\)))? *\)/y;

function parseInlines(text: string, ctx: ParseContext): DocInline[] {
  const tokens: InlineToken[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain.length > 0) tokens.push({ kind: "text", text: plain });
    plain = "";
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index]!;

    if (char === "\\") {
      const next = text[index + 1];
      if (next !== undefined && ASCII_PUNCTUATION.test(next)) {
        plain += next;
        index += 2;
      } else {
        plain += char;
        index++;
      }
      continue;
    }

    if (char === "`") {
      const span = matchCodeSpan(text, index);
      if (span.close < 0) {
        plain += text.slice(index, span.end);
      } else {
        flush();
        tokens.push({ kind: "code", text: codeSpanText(text.slice(span.contentStart, span.close)) });
      }
      index = span.end;
      continue;
    }

    if (char === "!" && text[index + 1] === "[") {
      const image = parseLinkAt(text, index + 1, ctx);
      if (image) {
        plain += image.label ? `[Image: ${image.label}]` : "[Image]";
        index = image.end;
        continue;
      }
    }

    if (char === "[") {
      const link = parseLinkAt(text, index, ctx);
      if (link) {
        flush();
        for (const inline of parseInlines(link.label, ctx)) {
          tokens.push({ ...inline, kind: "link", target: link.target, external: true });
        }
        index = link.end;
        continue;
      }
    }

    if (char === "<") {
      AUTOLINK.lastIndex = index;
      const autolink = AUTOLINK.exec(text);
      if (autolink) {
        flush();
        tokens.push({ kind: "link", text: autolink[1]!, target: autolink[1]!, external: true });
        index += autolink[0].length;
        continue;
      }
    }

    if ((char === "h" || char === "w") && !/[A-Za-z0-9]/.test(text[index - 1] ?? " ")) {
      BARE_URL.lastIndex = index;
      const bare = BARE_URL.exec(text);
      if (bare) {
        const url = trimUrlPunctuation(bare[0]);
        flush();
        tokens.push({ kind: "link", text: url, target: url, external: true });
        index += url.length;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      flush();
      let end = index;
      while (text[end] === char) end++;
      tokens.push(delimiterToken(char, end - index, text[index - 1], text[end]));
      index = end;
      continue;
    }

    plain += char;
    index++;
  }
  flush();
  resolveEmphasis(tokens);
  return finishInlines(tokens);
}

/**
 * The backtick run at `open` and the next run of the same length, which closes
 * the span. With no such run, `close` is -1 and `end` is just past the opening run.
 */
function matchCodeSpan(text: string, open: number): { contentStart: number; close: number; end: number } {
  let contentStart = open;
  while (text[contentStart] === "`") contentStart++;
  const ticks = contentStart - open;
  let cursor = contentStart;
  while (cursor < text.length) {
    if (text[cursor] !== "`") {
      cursor++;
      continue;
    }
    let runEnd = cursor;
    while (text[runEnd] === "`") runEnd++;
    if (runEnd - cursor === ticks) return { contentStart, close: cursor, end: runEnd };
    cursor = runEnd;
  }
  return { contentStart, close: -1, end: contentStart };
}

/** One space of padding on both sides lets a code span start or end with a backtick. */
function codeSpanText(raw: string): string {
  const text = raw.replace(/\n/g, " ");
  return text.length > 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim().length > 0
    ? text.slice(1, -1)
    : text;
}

/** The link (or image, with `open` at its bracket) whose "[" is at `open`, or null. */
function parseLinkAt(
  text: string,
  open: number,
  ctx: ParseContext,
): { label: string; target: string; end: number } | null {
  const close = findClosingBracket(text, open);
  if (close < 0) return null;
  const label = text.slice(open + 1, close);
  const afterClose = close + 1;

  if (text[afterClose] === "(") {
    LINK_TAIL.lastIndex = afterClose;
    const tail = LINK_TAIL.exec(text);
    if (tail) return { label, target: tail[1] ?? tail[2] ?? "", end: afterClose + tail[0].length };
  }

  if (text[afterClose] === "[") {
    const refClose = findClosingBracket(text, afterClose);
    if (refClose >= 0) {
      const ref = text.slice(afterClose + 1, refClose);
      const target = ctx.references.get(normalizeLabel(ref || label));
      if (target !== undefined) return { label, target, end: refClose + 1 };
    }
  }

  const target = ctx.references.get(normalizeLabel(label));
  return target !== undefined ? { label, target, end: afterClose } : null;
}

function findClosingBracket(text: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") {
      index = matchCodeSpan(text, index).end;
      continue;
    }
    if (char === "[") depth++;
    if (char === "]") {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  return -1;
}

/** Sentence punctuation after a bare URL isn't part of it (nor is an unmatched close paren). */
function trimUrlPunctuation(url: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1]!;
    if ("?!.,:;*_~'\"".includes(char)) {
      end--;
    } else if (char === ")" && count(url.slice(0, end), ")") > count(url.slice(0, end), "(")) {
      end--;
    } else {
      break;
    }
  }
  return url.slice(0, end);
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** CommonMark's flanking rules decide whether a delimiter run can open or close emphasis. */
function delimiterToken(
  char: "*" | "_",
  length: number,
  before: string | undefined,
  after: string | undefined,
): DelimiterToken {
  const beforeSpace = before === undefined || /\s/.test(before);
  const afterSpace = after === undefined || /\s/.test(after);
  const beforePunct = !beforeSpace && NOT_LETTER_OR_NUMBER.test(before);
  const afterPunct = !afterSpace && NOT_LETTER_OR_NUMBER.test(after);
  const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  const canOpen = char === "*" ? leftFlanking : leftFlanking && (!rightFlanking || beforePunct);
  const canClose = char === "*" ? rightFlanking : rightFlanking && (!leftFlanking || afterPunct);
  return { kind: "delimiter", char, count: length, original: length, canOpen, canClose };
}

/** Match closers to the nearest openers, styling everything between each pair. */
function resolveEmphasis(tokens: InlineToken[]): void {
  for (let closeIndex = 0; closeIndex < tokens.length; closeIndex++) {
    const closer = tokens[closeIndex]!;
    if (closer.kind !== "delimiter" || !closer.canClose) continue;
    while (closer.count > 0) {
      const openIndex = findOpener(tokens, closeIndex, closer);
      if (openIndex < 0) break;
      const opener = tokens[openIndex] as DelimiterToken;
      const used = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
      opener.count -= used;
      closer.count -= used;
      for (let index = openIndex + 1; index < closeIndex; index++) {
        const inner = tokens[index]!;
        if (closer.char === "*") inner.bold = true;
        else inner.underline = true;
        // A delimiter inside a matched pair can no longer pair across it.
        if (inner.kind === "delimiter") {
          inner.canOpen = false;
          inner.canClose = false;
        }
      }
    }
  }
}

function findOpener(tokens: readonly InlineToken[], closeIndex: number, closer: DelimiterToken): number {
  for (let index = closeIndex - 1; index >= 0; index--) {
    const token = tokens[index]!;
    if (token.kind !== "delimiter" || token.char !== closer.char || token.count === 0 || !token.canOpen) continue;
    // Rule of 3: keeps *foo**bar**baz* from pairing the outer * with the inner **.
    const bothMultiplesOf3 = token.original % 3 === 0 && closer.original % 3 === 0;
    if ((token.canClose || closer.canOpen) && (token.original + closer.original) % 3 === 0 && !bothMultiplesOf3) continue;
    return index;
  }
  return -1;
}

/** Unmatched delimiters become literal text; adjacent same-styled text merges. */
function finishInlines(tokens: readonly InlineToken[]): DocInline[] {
  const inlines: DocInline[] = [];
  for (const token of tokens) {
    const inline: DocInline = token.kind === "delimiter" ? delimiterText(token) : token;
    if (inline.text.length === 0) continue;
    const last = inlines[inlines.length - 1];
    if (
      last &&
      last.kind === "text" &&
      inline.kind === "text" &&
      !!last.bold === !!inline.bold &&
      !!last.underline === !!inline.underline
    ) {
      last.text += inline.text;
    } else {
      inlines.push(inline);
    }
  }
  return inlines;
}

function delimiterText(token: DelimiterToken): DocInline {
  const inline: DocInline = { kind: "text", text: token.char.repeat(token.count) };
  if (token.bold) inline.bold = true;
  if (token.underline) inline.underline = true;
  return inline;
}
