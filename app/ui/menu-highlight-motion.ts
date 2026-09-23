export const MENU_HIGHLIGHT_DURATION_MS = 300;
export type MenuHighlightAnimation = { dx: number; dy: number; startedAt: number; token: number; durationMs: number };

let nextToken = 1;

/** Eligibility is decided by menu navigation, before the display-list bridge. */
export class MenuHighlightMotion {
  private previous?: { index: number; scroll: number; x: number; y: number; width: number; height: number };
  private fromIndex: number | null = null;
  private animation?: MenuHighlightAnimation;

  navigate(from: number, wrapped: boolean): void {
    this.fromIndex = wrapped ? null : from;
  }

  paint(index: number, scroll: number, x: number, y: number, width: number, height: number, now: number): MenuHighlightAnimation | undefined {
    const previous = this.previous;
    if (!previous || previous.index !== index || previous.scroll !== scroll ||
        previous.x !== x || previous.y !== y || previous.width !== width || previous.height !== height) {
      let fromX = previous?.x ?? x, fromY = previous?.y ?? y;
      if (previous && this.animation) {
        const t = Math.max(0, Math.min(1, (now - this.animation.startedAt) / this.animation.durationMs));
        const remaining = 1 - t * t * (3 - 2 * t);
        fromX += this.animation.dx * remaining;
        fromY += this.animation.dy * remaining;
      }
      const eligible = previous && previous.index !== index && this.fromIndex === previous.index &&
        previous.scroll === scroll && previous.width === width && previous.height === height;
      this.animation = eligible ? { dx: Math.round(fromX - x), dy: Math.round(fromY - y), startedAt: now, token: nextToken++, durationMs: MENU_HIGHLIGHT_DURATION_MS } : undefined;
      this.fromIndex = null;
      this.previous = { index, scroll, x, y, width, height };
    }
    return this.animation && now - this.animation.startedAt < this.animation.durationMs ? this.animation : undefined;
  }
}
