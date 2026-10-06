import { scaleAnimationDuration, type AnimationSpeed } from "./animation-speed";

/**
 * How fast menus and icon grids animate on the glasses (Settings > Customization >
 * Animations > Menu animation). The motion classes can't read the settings
 * store themselves (it is native, and they load under Node in unit tests),
 * so ui/menu.ts installs a reader in each isolate that paints menus. Without
 * one, menus animate at Normal speed.
 */
export const MENU_ANIMATION_KEY = "display.menuAnimationSpeed";

let readMenuAnimationSpeed: () => AnimationSpeed = () => "normal";

/** A menu animation's Normal-speed duration at the configured speed; 0 when menu animation is disabled. */
export function menuAnimationDurationMs(normalMs: number): number {
  return scaleAnimationDuration(normalMs, readMenuAnimationSpeed());
}

export function setMenuAnimationReader(read: () => AnimationSpeed): void {
  readMenuAnimationSpeed = read;
}
