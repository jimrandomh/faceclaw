import { GrayImage } from "../graphics/image";
import { singlePlane, type Plane } from "../graphics/plane";
import { GESTURE_LONG_PRESS, gestureHints, type InputEvent } from "./gestures";
import { type Layer, LayerStack, noopLayerActions } from "./layers";
import { MenuLayer, type MenuItem, type MenuLayout } from "./menu";
import type { WorkerAppReply } from "./shell/worker-window";

/**
 * The window context menu, opened by tap-then-hold: an app's own menu,
 * holding its app-specific actions. The shell's system menu (long-press)
 * carries the entries every window shares — Focus app switcher, Voice input,
 * Close window — so an app with nothing of its own to offer has no menu of
 * its own: tap-then-hold then opens the system menu in its place, so both
 * gestures land on the same menu. The system menu is also the safety net:
 * shell-owned, so an unresponsive app can always be closed (a window that
 * claims long-press for a move of its own reaches it by holding the press).
 */

/** Centered over the viewport; visually matches the shell's system menu position. */
export const WINDOW_MENU_LAYOUT: MenuLayout = {
  x: "center",
  y: 8,
  width: 272,
  minHeight: 150,
  footer: gestureHints([[GESTURE_LONG_PRESS, "system menu"]]),
};

export class WindowMenuLayer extends MenuLayer {
  constructor(title: string | null, items: MenuItem[]) {
    super(title, items, WINDOW_MENU_LAYOUT);
  }
}

export type WindowMenuOptions = {
  windowId: string;
  post: (reply: WorkerAppReply) => void;
  /** Menu title: the window's title, read at open time. */
  title: () => string;
  /**
   * The app's menu entries, built at open time so they reflect current
   * state. Empty means the window has no context menu right now: open()
   * asks the shell for the system menu instead.
   */
  items: () => MenuItem[];
  /**
   * True while the app gives long-press a meaning of its own (a game move).
   * The shell then forwards long-presses to the window instead of opening
   * the system menu on them; holding the press past the escape threshold
   * still reaches the system menu. Default: never.
   */
  claimsLongPress?: () => boolean;
  /** Paint the window content the menu draws over (a fresh, mutable image). */
  paintBase: () => GrayImage;
  size: { width: number; height: number };
  isFocused: () => boolean;
};

/**
 * Menu host for worker apps, which paint pixels directly rather than through
 * a persistent LayerStack. Wraps a short-lived stack so MenuLayer (and the
 * ctx.stack.pop() convention in item callbacks) works unchanged.
 *
 * Usage: answer tap-then-hold with open(); route input to handleInput while
 * isOpen(); paint every frame through paint(), which returns the window
 * content with the menu drawn over it and keeps the shell told about the
 * window's gesture bindings (whether it has a menu, whether it claims
 * long-press).
 */
export class WindowMenu {
  private stack: LayerStack | null = null;
  private reported: { hasAppMenu: boolean; claimsLongPress: boolean } | null = null;

  constructor(private readonly options: WindowMenuOptions) {}

  isOpen(): boolean {
    return this.stack !== null;
  }

  /** True when tap-then-hold currently opens this menu with something in it. */
  isAvailable(): boolean {
    return this.options.items().length > 0;
  }

  /**
   * Open the menu, or the shell's system menu when this window has no
   * entries. `items` overrides the window's own entries for an app that
   * reuses this host for another list (a per-row action menu).
   */
  open(items: MenuItem[] = this.options.items()): void {
    if (this.stack) return;
    if (!items.length) {
      this.options.post({ type: "open-system-menu", windowId: this.options.windowId });
      return;
    }
    const base: Layer = {
      paint: () => this.options.paintBase(),
      handleInput: () => {},
    };
    const stack = new LayerStack(base, { ...noopLayerActions }, this.options.size, this.options.isFocused);
    stack.push(new WindowMenuLayer(this.options.title(), items));
    this.stack = stack;
  }

  /**
   * Paint the window content with the menu over it. `content` paints the
   * closed-state content (default: paintBase alone), for windows whose
   * ordinary frame has more planes than the menu needs beneath it.
   */
  paint(content?: () => Plane[]): Plane[] {
    this.syncGestures();
    if (this.stack) return this.stack.paint();
    return content ? content() : singlePlane(this.options.paintBase());
  }

  /** Tell the shell when this window's gesture bindings change. */
  private syncGestures(): void {
    const hasAppMenu = this.isAvailable();
    const claimsLongPress = this.options.claimsLongPress?.() ?? false;
    if (this.reported?.hasAppMenu === hasAppMenu && this.reported.claimsLongPress === claimsLongPress) return;
    this.reported = { hasAppMenu, claimsLongPress };
    this.options.post({
      type: "set-window-gestures",
      windowId: this.options.windowId,
      hasAppMenu,
      claimsLongPress,
    });
  }

  /** Route an input event to the menu; the menu closes by popping itself. */
  async handleInput(event: InputEvent): Promise<void> {
    const stack = this.stack;
    if (!stack) return;
    // The shell opened its system menu over this window; close ours so the
    // two context menus never stack.
    if (event.type === "system-menu-opened") {
      stack.clearToBase();
      this.stack = null;
      return;
    }
    await stack.handleInput(event);
    if (stack.isAtBase()) {
      this.stack = null;
    }
  }
}
