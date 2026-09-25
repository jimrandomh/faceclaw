import type { MenuHighlightAnimation } from '../ui/menu-highlight-motion';
import { DrawExpression as E, type DrawValue } from './draw-expression';
import { DrawOp, type DisplayList, type ListCall, type ListImage } from './display-list';

export type MenuScrollHighlight = {
  /** Row top within the viewport; clamped inside it. */
  y: DrawValue;
  width: number;
  height: number;
  radius: number;
  /** Gray8, like drawMenuSelection. */
  background: number;
  border: number;
};

/**
 * A highlight sliding by (0, dy) to rest at `y`, on a list timeline that
 * started at `timelineStart` (the slide may have started before or after it).
 */
export function slidingHighlightY(y: number, motion: MenuHighlightAnimation | undefined, timelineStart: number): E<'i32'> {
  if (!motion?.dy) return E.i32(y);
  return E.progress(motion.durationMs, motion.startedAt - timelineStart).ease()
    .lerp(E.i32(y + motion.dy).toFloat(), E.i32(y).toFloat()).toInt();
}

/**
 * A menu viewport moving over a pre-rendered strip. `strip` holds every row
 * visible at any point of the motion, and sits `stripX` pixels into the
 * viewport; `sourceY` is the strip row at the viewport's top, animated on
 * `timeline`. The highlight is max-blended over the copied rows.
 */
export function menuScrollList(strip: ListImage, stripX: number, viewportHeight: number,
    timeline: { token: number; startedAt: number }, sourceY: DrawValue, highlight?: MenuScrollHighlight): DisplayList {
  const calls: ListCall[] = [
    { op: DrawOp.RECT_COPY, resource: 0, x: 0, y: sourceY, width: strip.width, height: viewportHeight, dx: stripX, dy: 0 },
  ];
  if (highlight) {
    const q = (n: number) => Math.min(15, (n + 8) >> 4);
    const y = typeof highlight.y === 'number' ? highlight.y
      : highlight.y.max(E.i32(0)).min(E.i32(viewportHeight - highlight.height));
    calls.push({ op: DrawOp.ROUNDED_RECT, x: 0, y, width: highlight.width, height: highlight.height, radius: highlight.radius,
      background: q(highlight.background), border: q(highlight.border) });
  }
  return { resources: [strip], timeline: { token: timeline.token, startedAt: timeline.startedAt }, calls };
}
