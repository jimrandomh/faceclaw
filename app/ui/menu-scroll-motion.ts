import { DrawExpression as E, ExprOp } from "../graphics/draw-expression";
import { MENU_HIGHLIGHT_DURATION_MS, nextAnimationToken } from "./menu-highlight-motion";

/** Longest scroll, in pixels, that animates; longer jumps snap. */
export const MAX_ANIMATED_SCROLL = 96;
export const MENU_BOUNCE_DURATION_MS = 320;
/** Fraction of a bounce spent moving out to the peak; the rest settles back. */
const BOUNCE_PEAK = 0.35;

/**
 * The viewport's content offset moving from `from` to `to`, on the same clock
 * as the highlight. A bounce passes through `peak` on the way (usually past
 * the end of the list, with `to` where it started).
 */
export type MenuScrollAnimation = {
  from: number; to: number; peak?: number;
  startedAt: number; token: number; durationMs: number;
};

type Box = { x: number; y: number; width: number; height: number };

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** The offset at timeline fraction t (0..1). Keep in sync with scrollOffsetExpression. */
export function scrollOffsetAt(animation: MenuScrollAnimation, t: number): number {
  const { from, to, peak } = animation;
  if (peak === undefined) return from + (to - from) * smoothstep(clamp01(t));
  const out = 1 - (1 - clamp01(t / BOUNCE_PEAK)) ** 2;
  const back = smoothstep(clamp01((t - BOUNCE_PEAK) / (1 - BOUNCE_PEAK)));
  return from + (peak - from) * out + (to - peak) * back;
}

/**
 * The offset as a draw expression on the animation's own timeline. The easing
 * ops clamp their input, which splits a bounce into its two phases without
 * comparisons: the return term stays 0 until the peak, the outward one stays 1 after.
 */
export function scrollOffsetExpression(animation: MenuScrollAnimation) {
  const { from, to, peak } = animation;
  const t = () => E.progress(animation.durationMs);
  if (peak === undefined) return t().ease().lerp(E.i32(from).toFloat(), E.i32(to).toFloat()).toInt();
  const out = t().mul(E.f32(1 / BOUNCE_PEAK)).ease(ExprOp.EASE_OUT_QUAD);
  const back = t().sub(E.f32(BOUNCE_PEAK)).div(E.f32(1 - BOUNCE_PEAK)).ease();
  return E.i32(from).toFloat()
    .add(E.i32(peak - from).toFloat().mul(out))
    .add(E.i32(to - peak).toFloat().mul(back)).toInt();
}

/**
 * Tracks the painted scroll offset. A change caused by non-wrapping
 * navigation animates; programmatic scrolls, item edits and geometry changes
 * snap. A bounce is requested explicitly, at an end of the list. Either starts
 * from the offset on screen now, so it can interrupt one in flight.
 */
export class MenuScrollMotion {
  private previous?: { scroll: number; box: Box };
  private navigated = false;
  private bounceBy = 0;
  private animation?: MenuScrollAnimation;

  navigate(wrapped: boolean): void {
    this.navigated = !wrapped;
  }

  /** Overshoot by `offset` pixels (negative past the top) and come back, at the next paint. */
  bounce(offset: number): void {
    this.bounceBy = offset;
  }

  /** Record this paint's settled offset; returns the animation in flight, if any. */
  paint(scroll: number, box: Box, now: number): MenuScrollAnimation | undefined {
    const previous = this.previous;
    const sameBox = !!previous && previous.box.x === box.x && previous.box.y === box.y &&
      previous.box.width === box.width && previous.box.height === box.height;
    if (!previous || !sameBox || previous.scroll !== scroll) {
      const from = previous ? this.offsetAt(previous.scroll, now) : scroll;
      const eligible = sameBox && this.navigated && from !== scroll && Math.abs(scroll - from) <= MAX_ANIMATED_SCROLL;
      this.animation = eligible
        ? { from, to: scroll, startedAt: now, token: nextAnimationToken(), durationMs: MENU_HIGHLIGHT_DURATION_MS }
        : undefined;
      this.previous = { scroll, box: { ...box } };
    } else if (this.bounceBy) {
      const from = this.offsetAt(scroll, now);
      this.animation = Math.abs(scroll - from) <= MAX_ANIMATED_SCROLL
        ? { from, peak: scroll + this.bounceBy, to: scroll, startedAt: now, token: nextAnimationToken(), durationMs: MENU_BOUNCE_DURATION_MS }
        : undefined;
    }
    this.navigated = false;
    this.bounceBy = 0;
    return this.animation && now - this.animation.startedAt < this.animation.durationMs ? this.animation : undefined;
  }

  /** Cancel an animation in flight, e.g. when it cannot be drawn; the next change snaps from `settled`. */
  cancel(): void {
    this.animation = undefined;
  }

  private offsetAt(settled: number, now: number): number {
    const animation = this.animation;
    if (!animation) return settled;
    return Math.round(scrollOffsetAt(animation, (now - animation.startedAt) / animation.durationMs));
  }
}
