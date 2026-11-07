/**
 * Maps Roam block trees (roam-api.ts) into the shared document model
 * (ui/document): parses the subset of Roam markup the glasses can render —
 * {{[[TODO]]}} / {{[[DONE]]}} markers, [[page]] / #tag / [text](url) links,
 * `inline code` and ```code blocks``` — and strips emphasis markers.
 * Also the block-lookup helpers the voice tools use.
 */
import type { DocInline, DocNode, DocumentRoot } from "../../ui/document/document-model";
import type { RoamBlock, RoamPage } from "./roam-api";

const TODO_MARKER = /^\s*\{\{(?:\[\[)?(TODO|DONE)(?:\]\])?\}\}\s*/;
const CODE_BLOCK = /^```([^\n`]*)\n?([\s\S]*?)```\s*$/;

export function pageToDocument(page: RoamPage): DocumentRoot {
  return { title: page.title, nodes: page.children.map(blockToNode) };
}

function blockToNode(block: RoamBlock): DocNode {
  const children = block.children.map(blockToNode);
  const text = block.string;

  const codeMatch = CODE_BLOCK.exec(text.trim());
  if (codeMatch) {
    return { id: block.uid, kind: "code", inlines: [], codeText: codeMatch[2] ?? "", children };
  }

  const todoMatch = TODO_MARKER.exec(text);
  if (todoMatch) {
    return {
      id: block.uid,
      kind: "todo",
      checked: todoMatch[1] === "DONE",
      inlines: parseInlineMarkup(text.slice(todoMatch[0].length)),
      children,
    };
  }

  if (block.heading) {
    return { id: block.uid, kind: "heading", level: block.heading, inlines: parseInlineMarkup(text), children };
  }

  return { id: block.uid, kind: "text", bullet: true, inlines: parseInlineMarkup(text), children };
}

/** Flip a block string's {{[[TODO]]}} / {{[[DONE]]}} marker (adding one if absent). */
export function setTodoMarker(text: string, done: boolean): string {
  const marker = done ? "{{[[DONE]]}}" : "{{[[TODO]]}}";
  const match = TODO_MARKER.exec(text);
  if (match) return `${marker} ${text.slice(match[0].length)}`;
  return `${marker} ${text}`;
}

export function isTodoBlock(text: string): boolean {
  return TODO_MARKER.test(text);
}

/** The block's text with todo marker and inline markup stripped. */
export function plainBlockText(text: string): string {
  const withoutMarker = text.replace(TODO_MARKER, "");
  const codeMatch = CODE_BLOCK.exec(withoutMarker.trim());
  if (codeMatch) return codeMatch[2] ?? "";
  return parseInlineMarkup(withoutMarker)
    .map((inline) => inline.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Inline markup

export function parseInlineMarkup(text: string): DocInline[] {
  // Emphasis isn't mapped onto the document model's bold/underline; drop the markers.
  const source = text.replace(/\*\*|__|\^\^|~~/g, "");
  const inlines: DocInline[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain.length > 0) inlines.push({ kind: "text", text: plain });
    plain = "";
  };

  let index = 0;
  while (index < source.length) {
    if (source.startsWith("[[", index) || source.startsWith("#[[", index)) {
      const open = source[index] === "#" ? index + 3 : index + 2;
      const close = matchDoubleBracket(source, open);
      if (close >= 0) {
        const target = source.slice(open, close);
        flush();
        inlines.push({ kind: "link", text: target.replace(/\[\[|\]\]/g, ""), target });
        index = close + 2;
        continue;
      }
    }
    if (source[index] === "#" && /[\w/]/.test(source[index + 1] ?? "")) {
      const tagMatch = /^[\w/-]+/.exec(source.slice(index + 1));
      if (tagMatch) {
        flush();
        inlines.push({ kind: "link", text: tagMatch[0], target: tagMatch[0] });
        index += 1 + tagMatch[0].length;
        continue;
      }
    }
    if (source[index] === "`") {
      const close = source.indexOf("`", index + 1);
      if (close >= 0) {
        flush();
        inlines.push({ kind: "code", text: source.slice(index + 1, close) });
        index = close + 1;
        continue;
      }
    }
    if (source[index] === "[" && !source.startsWith("[[", index)) {
      const labelEnd = source.indexOf("](", index + 1);
      const urlEnd = labelEnd >= 0 ? source.indexOf(")", labelEnd + 2) : -1;
      if (labelEnd >= 0 && urlEnd >= 0) {
        flush();
        inlines.push({
          kind: "link",
          text: source.slice(index + 1, labelEnd),
          target: source.slice(labelEnd + 2, urlEnd),
          external: true,
        });
        index = urlEnd + 1;
        continue;
      }
    }
    plain += source[index];
    index++;
  }
  flush();
  return inlines;
}

/** Offset of the "]]" closing a "[[" whose contents start at `start`, honoring nesting. */
function matchDoubleBracket(source: string, start: number): number {
  let depth = 1;
  for (let index = start; index < source.length - 1; index++) {
    if (source.startsWith("[[", index)) {
      depth++;
      index++;
    } else if (source.startsWith("]]", index)) {
      depth--;
      if (depth === 0) return index;
      index++;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Block lookup helpers (voice tools)

export type FlatBlock = { block: RoamBlock; depth: number };

export function flattenBlocks(page: RoamPage): FlatBlock[] {
  const out: FlatBlock[] = [];
  const visit = (block: RoamBlock, depth: number): void => {
    out.push({ block, depth });
    for (const child of block.children) visit(child, depth + 1);
  };
  for (const block of page.children) visit(block, 0);
  return out;
}

/**
 * The uid new todos should be created under: the first block that reads like
 * a todo-section header ("Todo", "Todos", "TODO:"), else the page itself.
 */
export function findTodoParentUid(page: RoamPage): string {
  for (const { block } of flattenBlocks(page)) {
    if (/^todos?:?$/i.test(plainBlockText(block.string).trim())) return block.uid;
  }
  return page.uid;
}

/**
 * Find the block best matching a spoken/typed query: exact plain-text match
 * first, then prefix, then substring, all case-insensitive, in document order.
 */
export function findBlockMatching(
  page: RoamPage,
  query: string,
  filter?: (block: RoamBlock) => boolean,
): RoamBlock | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  let prefix: RoamBlock | null = null;
  let substring: RoamBlock | null = null;
  for (const { block } of flattenBlocks(page)) {
    if (filter && !filter(block)) continue;
    const plain = plainBlockText(block.string).trim().toLowerCase();
    if (plain === needle) return block;
    if (!prefix && plain.startsWith(needle)) prefix = block;
    if (!substring && plain.includes(needle)) substring = block;
  }
  return prefix ?? substring;
}

/** Render the page as indented text with [ ]/[x] markers, for the assistant. */
export function pageToToolText(page: RoamPage): string {
  const lines: string[] = [];
  for (const { block, depth } of flattenBlocks(page)) {
    const indent = "  ".repeat(depth);
    const text = plainBlockText(block.string).trim();
    if (!text) continue;
    if (isTodoBlock(block.string)) {
      const done = /^\s*\{\{(?:\[\[)?DONE/.test(block.string);
      lines.push(`${indent}- [${done ? "x" : " "}] ${text}`);
    } else {
      lines.push(`${indent}- ${text}`);
    }
  }
  return lines.length > 0 ? `${page.title}\n${lines.join("\n")}` : `${page.title}\n(page is empty)`;
}
