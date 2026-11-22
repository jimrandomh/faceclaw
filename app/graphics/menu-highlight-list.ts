import type { MenuHighlightAnimation } from '../ui/menu-highlight-motion';
import { DrawExpression as E } from './draw-expression';
import { DrawOp, type DisplayList } from './display-list';

/**
 * A menu's selection box: a rounded rectangle over the selected row, which is
 * already drawn in the pixels beneath. Its fill max-blends with them, so the
 * row's content shows through; an animation slides it in from the previous
 * row. Menu policy and easing live in TypeScript; the bridge carries only
 * generic calls/expressions.
 */
export function menuHighlightList(width: number, height: number, background: number, border: number, radius: number, animation?: MenuHighlightAnimation): DisplayList {
  const coordinate = (delta: number) => {
    if (!animation || !delta) return 0;
    const progress = E.progress(animation.durationMs).ease();
    return progress.lerp(E.i32(delta).toFloat(), E.f32(0)).toInt();
  };
  const q = (n: number) => Math.min(15, (n + 8) >> 4);
  return { resources: [], timeline: animation,
    calls: [
      { op: DrawOp.ROUNDED_RECT, x: coordinate(animation?.dx ?? 0), y: coordinate(animation?.dy ?? 0), width, height, radius, background: q(background), border: q(border) },
    ] };
}
