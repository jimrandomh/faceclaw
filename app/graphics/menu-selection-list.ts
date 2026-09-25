import type { MenuHighlightAnimation } from '../ui/menu-highlight-motion';
import { DrawExpression as E } from './draw-expression';
import { DrawOp, type DisplayList, type ListImage } from './display-list';

/** Menu policy and easing live in TypeScript; the bridge carries only generic calls/expressions. */
export function menuSelectionList(image: ListImage, background: number, border: number, radius: number, animation?: MenuHighlightAnimation): DisplayList {
  const coordinate = (delta: number) => {
    if (!animation || !delta) return 0;
    const progress = E.progress(animation.durationMs).ease();
    return progress.lerp(E.i32(delta).toFloat(), E.f32(0)).toInt();
  };
  const q = (n: number) => Math.min(15, (n + 8) >> 4);
  return { resources: [image], timeline: animation,
    calls: [
      { op: DrawOp.ROUNDED_RECT, x: coordinate(animation?.dx ?? 0), y: coordinate(animation?.dy ?? 0), width: image.width, height: image.height, radius, background: q(background), border: q(border) },
      { op: DrawOp.IMAGE, resource: 0, x: 0, y: 0, transparent: true },
    ] };
}
