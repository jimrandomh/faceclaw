/**
 * A window's viewport as its layouts see it: its size, what lies past each
 * of its edges, and how much padding to leave at each because of that. Pure
 * data, so it crosses to app workers in their open/resize messages.
 */

/**
 * What a viewport edge touches: a line the shell draws right outside it
 * ("border": a side of the window frame, the status bar's divider, the app
 * switcher's separator), or nothing ("offscreen": the end of the screen, or
 * space the shell leaves blank, which looks the same on the glasses; chrome
 * with no line before it, a status bar or switcher row, counts too).
 */
export type EdgeKind = "border" | "offscreen";

export type Edges<T> = { top: T; right: T; bottom: T; left: T };

export type ViewportSize = { width: number; height: number };

export type Viewport = ViewportSize & {
  edges: Edges<EdgeKind>;
  /**
   * Suggested distance to keep between each edge and the content nearest it
   * (see suggestedPadding). A layout puts its outermost element this far in,
   * rather than hard-coding a margin, so it has room beside a border line
   * and wastes none beside blank space. A vertical scroll container is the
   * exception: its viewport runs to the top and bottom edges whatever they
   * touch, and the padding goes inside the scrolled content, before the
   * first element and after the last.
   */
  padding: Edges<number>;
};

/** Suggested padding between a border line and the content beside it. */
export const BORDER_EDGE_PADDING = 8;

/** Suggested content padding for each edge: room beside a border, none beside blank space. */
export function suggestedPadding(edges: Edges<EdgeKind>): Edges<number> {
  const pad = (edge: EdgeKind) => (edge === "border" ? BORDER_EDGE_PADDING : 0);
  return { top: pad(edges.top), right: pad(edges.right), bottom: pad(edges.bottom), left: pad(edges.left) };
}

export function uniformEdges(kind: EdgeKind): Edges<EdgeKind> {
  return { top: kind, right: kind, bottom: kind, left: kind };
}

/** A viewport of the given size and edges, with the padding suggested for them. */
export function viewportWith(size: ViewportSize, edges: Edges<EdgeKind>): Viewport {
  return { width: size.width, height: size.height, edges: { ...edges }, padding: suggestedPadding(edges) };
}

/**
 * Complete a bare size as a viewport nothing borders (no padding); one that
 * already says what its edges touch is copied as it is.
 */
export function toViewport(size: ViewportSize | Viewport): Viewport {
  if ("edges" in size && "padding" in size) {
    return { width: size.width, height: size.height, edges: { ...size.edges }, padding: { ...size.padding } };
  }
  return viewportWith(size, uniformEdges("offscreen"));
}

export function sameEdges(a: Edges<EdgeKind>, b: Edges<EdgeKind>): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

export function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.width === b.width && a.height === b.height && sameEdges(a.edges, b.edges)
    && a.padding.top === b.padding.top && a.padding.right === b.padding.right
    && a.padding.bottom === b.padding.bottom && a.padding.left === b.padding.left;
}

/** The rect inside a viewport's suggested padding, in its own coordinates. */
export function paddedRect(viewport: Viewport): { x: number; y: number; width: number; height: number } {
  const { padding } = viewport;
  return {
    x: padding.left,
    y: padding.top,
    width: Math.max(0, viewport.width - padding.left - padding.right),
    height: Math.max(0, viewport.height - padding.top - padding.bottom),
  };
}
