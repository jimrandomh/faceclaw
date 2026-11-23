import { DrawExpression as E, ExprOp } from "../../graphics/draw-expression";
import { DrawOp, type AnimatedListClip, type DisplayList, type ListCall, type ListClip } from "../../graphics/display-list";

/**
 * A folder's panel opening out of its icon, or closing back into it, on a
 * display-list timeline: the panel is a rect that grows from a point to its
 * full size (or shrinks from full size to the point), with the panel's content
 * showing through it as through a window.
 */
export type FolderTransition = { kind: "open" | "close"; startedAt: number; token: number; durationMs: number };

/**
 * The transition's display list, in the panel's coordinates (its corner at 0,
 * 0), for placing over the panel's rect.
 *
 * `point` is where the rect grows from or shrinks to. `content` returns the
 * calls that draw the panel's inside, every one of them limited to the clip it
 * is given (null if it can't be drawn that way); the list adds the panel's
 * black fill before them and its one-pixel border after, in `borderLevel`.
 *
 * Opening, the frame underneath already holds the open panel, so the list
 * first puts back what the panel covers: `underneath` draws that, given a
 * clip of the panel's whole rect. Closing, the frame underneath is already
 * what is left behind, and the shrinking rect uncovers it.
 *
 * Either way the last frame is the frame underneath, exactly: an open panel
 * drawn whole, or nothing. Null when either callback gives up.
 */
export function folderTransitionList(
  transition: FolderTransition,
  panel: { width: number; height: number },
  point: { x: number; y: number },
  borderLevel: number,
  content: (clip: AnimatedListClip) => ListCall[] | null,
  underneath?: (clip: ListClip) => ListCall[] | null,
): DisplayList | null {
  const opening = transition.kind === "open";
  // Opening starts fast and settles; closing is the same motion backwards.
  // Quadratic, not cubic: at the glasses' 45 ms a frame a transition is only
  // four or five frames, and a steeper curve spends most of them near one end.
  const progress = E.progress(transition.durationMs).ease(opening ? ExprOp.EASE_OUT_QUAD : ExprOp.EASE_IN_QUAD);
  /** A value that is `atPoint` while the rect is a point and `whole` when it is the panel. */
  const between = (atPoint: number, whole: number) => {
    const from = opening ? atPoint : whole, to = opening ? whole : atPoint;
    return progress.lerp(E.i32(from).toFloat(), E.i32(to).toFloat()).toInt();
  };
  const pointX = Math.max(0, Math.min(panel.width, Math.round(point.x)));
  const pointY = Math.max(0, Math.min(panel.height, Math.round(point.y)));
  const x = between(pointX, 0), y = between(pointY, 0);
  const width = between(0, panel.width), height = between(0, panel.height);
  const clip: AnimatedListClip = { animated: true, x, y, width, height };
  // The last column and row inside the rect. An empty rect clips these away.
  const right = x.add(width).sub(E.i32(1)), bottom = y.add(height).sub(E.i32(1));

  const calls: ListCall[] = [];
  if (opening) {
    const whole: ListClip = { x: 0, y: 0, width: panel.width, height: panel.height };
    const covered = underneath?.(whole);
    if (!covered) return null;
    calls.push({ op: DrawOp.CLEAR, color: 0, clip: whole }, ...covered);
  }
  const inside = content(clip);
  if (!inside) return null;
  calls.push({ op: DrawOp.CLEAR, color: 0, clip }, ...inside);
  const edges: [typeof x, typeof x, typeof x, typeof x][] = [
    [x, y, right, y], [x, bottom, right, bottom], [x, y, x, bottom], [right, y, right, bottom],
  ];
  for (const [x0, y0, x1, y1] of edges) calls.push({ op: DrawOp.LINE, x0, y0, x1, y1, color: borderLevel, clip });
  return { resources: [], timeline: { token: transition.token, startedAt: transition.startedAt }, calls };
}
