import { DrawExpression as E, type DrawValue } from "../../graphics/draw-expression";
import { DrawOp, type DisplayList, type ListCall } from "../../graphics/display-list";
import { type GlanceDividerLine } from "./layout";

/**
 * The board's dividers at the length the screen's fade has reached: each
 * grows out of its origin as the screen fades in and shrinks back into it as
 * the screen fades out, eased. `level` is their 4-bit color.
 *
 * There is no duration here. The lines' only input is the fade's progress, so
 * they take exactly as long as the fade does at whatever speed Settings >
 * Customization > Animations > Screen fade gives it, and are simply there
 * when it is disabled. Keep it that way: a clock of their own would drift
 * from the fade as soon as that setting changed.
 *
 * The list goes over a board whose pixels already hold the lines whole, so it
 * first erases each one. With the screen shown that leaves the frame as it
 * was.
 */
export function dividerFadeList(lines: readonly GlanceDividerLine[], level: number): DisplayList {
  const grown = E.fade().ease();
  /** Where an end is: at the line's origin while the screen is dark, at `end` once it is shown. */
  const reach = (origin: number, end: number): DrawValue =>
    origin === end ? end : grown.lerp(E.i32(origin).toFloat(), E.i32(end).toFloat()).toInt();
  const calls: ListCall[] = lines.map((line) => ({ op: DrawOp.LINE, x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1, color: 0 }));
  for (const line of lines) {
    calls.push({
      op: DrawOp.LINE,
      x0: reach(line.originX, line.x0), y0: reach(line.originY, line.y0),
      x1: reach(line.originX, line.x1), y1: reach(line.originY, line.y1),
      color: level,
    });
  }
  return { resources: [], calls };
}
