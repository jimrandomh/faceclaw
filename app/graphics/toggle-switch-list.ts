import { DrawExpression as E } from './draw-expression';
import { DrawOp, type DisplayList } from './display-list';

/** A toggle switch: a pill-shaped track with a round knob at its left end (off) or right end (on). */
export const TOGGLE_SWITCH_WIDTH = 34;
export const TOGGLE_SWITCH_HEIGHT = 16;
export const TOGGLE_TRACK_RADIUS = 8;
export const TOGGLE_KNOB_SIZE = 12;
export const TOGGLE_KNOB_RADIUS = 6;
/** The knob's gap from the track's edge, on every side. */
export const TOGGLE_KNOB_INSET = 2;

/** A switch flipping to its new state on a display-list timeline (see toggleSwitchList). */
export type ToggleSwitchAnimation = { startedAt: number; token: number; durationMs: number };

/**
 * A switch's gray8 values and its knob's x within the track. Off, the track of
 * a selected row is left black, so the row's highlight shows through it.
 */
export function toggleSwitchLook(on: boolean, selected: boolean): { fill: number; outline: number; knob: number; knobX: number } {
  return {
    fill: on ? 70 : selected ? 1 : 18,
    outline: on ? 130 : 55,
    knob: on ? 230 : selected ? 170 : 90,
    knobX: on ? TOGGLE_SWITCH_WIDTH - TOGGLE_KNOB_SIZE - TOGGLE_KNOB_INSET : TOGGLE_KNOB_INSET,
  };
}

/**
 * A switch flipping to `on`, over the same switch painted in its new state:
 * the knob slides across from the other end, and the lit track follows it
 * (or, switching off, recedes ahead of it) through an animated clip. Needs
 * firmware revision 45; without it the painted switch shows at once. The last
 * frame is that painted switch exactly.
 */
export function toggleSwitchList(on: boolean, selected: boolean, animation: ToggleSwitchAnimation): DisplayList {
  const level = (gray: number) => Math.min(15, (gray + 8) >> 4);
  const off = toggleSwitchLook(false, selected), lit = toggleSwitchLook(true, selected);
  const to = on ? lit : off, from = on ? off : lit;
  const slide = (start: number, end: number) =>
    E.progress(animation.durationMs).ease().lerp(E.i32(start).toFloat(), E.i32(end).toFloat()).toInt();
  const track = { x: 0, y: 0, width: TOGGLE_SWITCH_WIDTH, height: TOGGLE_SWITCH_HEIGHT, radius: TOGGLE_TRACK_RADIUS };
  return {
    resources: [],
    timeline: { token: animation.token, startedAt: animation.startedAt },
    calls: [
      { op: DrawOp.CLEAR, color: 0, clip: { x: 0, y: 0, width: TOGGLE_SWITCH_WIDTH, height: TOGGLE_SWITCH_HEIGHT } },
      { op: DrawOp.ROUNDED_RECT, ...track, background: level(off.fill), border: level(off.outline) },
      // The lit track, from its left end as far as the knob has got.
      { op: DrawOp.ROUNDED_RECT, ...track, background: level(lit.fill), border: level(lit.outline),
        clip: { animated: true, x: 0, y: 0, width: slide(on ? 0 : TOGGLE_SWITCH_WIDTH, on ? TOGGLE_SWITCH_WIDTH : 0), height: TOGGLE_SWITCH_HEIGHT } },
      { op: DrawOp.ROUNDED_RECT, x: slide(from.knobX, to.knobX), y: TOGGLE_KNOB_INSET, width: TOGGLE_KNOB_SIZE, height: TOGGLE_KNOB_SIZE,
        radius: TOGGLE_KNOB_RADIUS, background: level(to.knob), border: 16 },
    ],
  };
}
