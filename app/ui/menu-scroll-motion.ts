import { MENU_HIGHLIGHT_DURATION_MS, nextAnimationToken } from "./menu-highlight-motion";

/** Longest scroll, in pixels, that animates; longer jumps snap. */
export const MAX_ANIMATED_SCROLL = 96;

/** A viewport moving from content offset `from` to `to`, on the same clock as the highlight. */
export type MenuScrollAnimation = { from: number; to: number; startedAt: number; token: number; durationMs: number };

type Box = { x: number; y: number; width: number; height: number };

/**
 * Tracks the painted scroll offset. Only a change caused by non-wrapping
 * navigation animates; programmatic scrolls, item edits and geometry changes
 * snap. A scroll during an animation starts from the offset on screen now.
 */
export class MenuScrollMotion {
  private previous?: { scroll: number; box: Box };
  private navigated = false;
  private animation?: MenuScrollAnimation;

  navigate(wrapped: boolean): void {
    this.navigated = !wrapped;
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
    }
    this.navigated = false;
    return this.animation && now - this.animation.startedAt < this.animation.durationMs ? this.animation : undefined;
  }

  /** Cancel an animation in flight, e.g. when it cannot be drawn; the next change snaps from `settled`. */
  cancel(): void {
    this.animation = undefined;
  }

  private offsetAt(settled: number, now: number): number {
    const animation = this.animation;
    if (!animation) return settled;
    const t = Math.max(0, Math.min(1, (now - animation.startedAt) / animation.durationMs));
    return Math.round(animation.from + (animation.to - animation.from) * t * t * (3 - 2 * t));
  }
}
