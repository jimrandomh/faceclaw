/**
 * Source-agnostic document tree for rendering structured text (outlines,
 * todo lists, notes) on the glasses. Integrations (Roam, Markdown in
 * markdown.ts, and later Notion / Obsidian) map their native formats into this
 * structure; the DocumentView in document-view.ts renders it, either as a
 * selectable outline or as a paged reader. Deliberately much smaller than
 * HTML: block nodes nest to give indent levels, and inline spans cover only
 * the formatting the glasses can usefully draw (links, inline code, bold,
 * underline).
 */

export type DocInlineStyle = { bold?: boolean; underline?: boolean };

export type DocInline = DocInlineStyle &
  (
    | { kind: "text"; text: string }
    | {
        kind: "link";
        text: string;
        /** Page title or URL the link points at. */
        target: string;
        /** True for web URLs (not followable on the glasses); false for in-graph pages. */
        external?: boolean;
      }
    | { kind: "code"; text: string }
  );

/**
 * "quote" nodes have no text of their own: they draw a vertical bar beside
 * their children. "rule" nodes are a horizontal line.
 */
export type DocNodeKind = "text" | "todo" | "heading" | "code" | "quote" | "rule";

export type DocNode = {
  /** Stable id from the source (e.g. the Roam block uid); keys selection and edits. */
  id: string;
  kind: DocNodeKind;
  /** Todo nodes: whether the item is checked off. */
  checked?: boolean;
  /** Heading nodes: 1 (largest) to 6. */
  level?: number;
  /** Draw a bullet marker (outline/list item). Ignored for todo nodes. */
  bullet?: boolean;
  /** Literal list marker (e.g. "2.") drawn in place of a bullet. */
  marker?: string;
  /** Leave a paragraph gap above this node (prose; outline rows stay tight). */
  spaced?: boolean;
  /** Inline content for text/todo/heading nodes. */
  inlines: DocInline[];
  /** Code nodes: preformatted text, possibly multi-line. */
  codeText?: string;
  children: DocNode[];
};

export type DocumentRoot = {
  title: string;
  nodes: DocNode[];
};

/** The node's text with inline markup dropped (for matching and tool output). */
export function docNodePlainText(node: DocNode): string {
  if (node.kind === "code") return node.codeText ?? "";
  return node.inlines.map((inline) => inline.text).join("");
}

/** The node's first in-graph page link, if any (the click-to-follow target). */
export function docNodePageLink(node: DocNode): string | null {
  for (const inline of node.inlines) {
    if (inline.kind === "link" && !inline.external) return inline.target;
  }
  return null;
}

/** Depth-first flatten of a node tree. */
export function flattenDocNodes(nodes: readonly DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  const visit = (node: DocNode): void => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}
