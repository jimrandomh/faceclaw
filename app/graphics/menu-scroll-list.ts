import type { MenuHighlightAnimation } from '../ui/menu-highlight-motion';
import type { MenuScrollAnimation } from '../ui/menu-scroll-motion';
import { DrawExpression as E, type DrawValue } from './draw-expression';
import { DrawOp, type DisplayList, type ListCall, type ListImage } from './display-list';

export type MenuScrollHighlight = {
  /** Final row top within the viewport. */
  y: number;
  width: number;
  height: number;
  radius: number;
  /** Gray8, like drawMenuSelection. */
  background: number;
  border: number;
  animation?: MenuHighlightAnimation;
};

/**
 * A menu viewport scrolling over a pre-rendered strip. `strip` holds every
 * row that is visible at any point of the scroll, starting at content offset
 * `stripTop` and `stripX` pixels into the viewport. The copy's source row is
 * the animated value; the highlight is max-blended over the copied rows,
 * sliding on the same timeline and clamped inside the viewport.
 */
export function menuScrollList(strip: ListImage, stripX: number, stripTop: number, viewportHeight: number,
    scroll: MenuScrollAnimation, highlight?: MenuScrollHighlight): DisplayList {
  const eased = (durationMs: number, delayMs = 0) => E.progress(durationMs, delayMs).ease();
  const sourceY: DrawValue = eased(scroll.durationMs)
    .lerp(E.i32(scroll.from - stripTop).toFloat(), E.i32(scroll.to - stripTop).toFloat()).toInt();
  const calls: ListCall[] = [
    { op: DrawOp.RECT_COPY, resource: 0, x: 0, y: sourceY, width: strip.width, height: viewportHeight, dx: stripX, dy: 0 },
  ];
  if (highlight) {
    const q = (n: number) => Math.min(15, (n + 8) >> 4);
    const motion = highlight.animation;
    let y: DrawValue = highlight.y;
    if (motion?.dy) {
      const delay = Math.max(0, motion.startedAt - scroll.startedAt);
      y = eased(motion.durationMs, delay).lerp(E.i32(highlight.y + motion.dy).toFloat(), E.i32(highlight.y).toFloat()).toInt()
        .max(E.i32(0)).min(E.i32(viewportHeight - highlight.height));
    }
    calls.push({ op: DrawOp.ROUNDED_RECT, x: 0, y, width: highlight.width, height: highlight.height, radius: highlight.radius,
      background: q(highlight.background), border: q(highlight.border) });
  }
  return { resources: [strip], timeline: scroll, calls };
}
