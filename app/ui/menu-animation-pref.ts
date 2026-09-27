/**
 * Whether menus and icon grids animate on the glasses (Settings > Display >
 * Animations > Menu animation). The motion classes can't read the settings
 * store themselves (it is native, and they load under Node in unit tests),
 * so ui/menu.ts installs a reader in each isolate that paints menus. Without
 * one, menus animate.
 */
export const MENU_ANIMATION_KEY = "display.menuAnimation";

let readMenuAnimation: () => boolean = () => true;

export function menuAnimationEnabled(): boolean {
  return readMenuAnimation();
}

export function setMenuAnimationReader(read: () => boolean): void {
  readMenuAnimation = read;
}
