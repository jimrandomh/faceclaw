import { GrayImage } from "../graphics/image";
import { singlePlane, type Plane } from "../graphics/plane";
import { GESTURE_SHORT_THEN_LONG_PRESS, gestureHints, type InputEvent } from "./gestures";
import { type Layer, LayerStack, noopLayerActions } from "./layers";
import { MenuLayer, type MenuItem, type MenuLayout } from "./menu";
import type { WorkerAppReply } from "./shell/worker-window";

/**
 * The window long-press menu: an app's own context menu, holding its
 * app-specific actions. The shell's system menu (tap-then-hold, or a press
 * held past the escape threshold) carries the entries every window shares —
 * Focus app switcher, Voice input, Close window — so an app with nothing of
 * its own to offer has no menu of its own: a long-press then opens the system
 * menu in its place, so both gestures land on the same menu. The system menu
 * is also the safety net: shell-owned, so an unresponsive app can always be
 * closed.
 */

/** Centered over the viewport; visually matches the shell's system menu position. */
export const WINDOW_MENU_LAYOUT: MenuLayout = {
  x: "center",
  y: 8,
  width: 272,
  minHeight: 150,
  footer: gestureHints([[GESTURE_SHORT_THEN_LONG_PRESS, "system menu"]]),
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
   * state. Empty means the window has no context menu: open() asks the shell
   * for the system menu instead.
   */
  items: () => MenuItem[];
  /**
   * False while the app gives long-press a meaning of its own (a game move)
   * instead of opening this menu. Default: always true. Only informs the
   * shell's system-menu hint; what a long-press does stays the app's call.
   */
  longPressOpensMenu?: () => boolean;
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
 * Usage: answer a long-press with open(); route input to handleInput while
 * isOpen(); paint every frame through paint(), which returns the window
 * content with the menu drawn over it and keeps the shell told whether the
 * window currently has a menu (the system menu's gesture hint depends on it).
 */
export class WindowMenu {
  private stack: LayerStack | null = null;
  private reportedAvailable: boolean | null = null;

  constructor(private readonly options: WindowMenuOptions) {}

  isOpen(): boolean {
    return this.stack !== null;
  }

  /** True when a long-press currently opens this menu with something in it. */
  isAvailable(): boolean {
    return (this.options.longPressOpensMenu?.() ?? true) && this.options.items().length > 0;
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
    this.syncAvailability();
    if (this.stack) return this.stack.paint();
    return content ? content() : singlePlane(this.options.paintBase());
  }

  /** Tell the shell when this window gains or loses its context menu. */
  private syncAvailability(): void {
    const available = this.isAvailable();
    if (available === this.reportedAvailable) return;
    this.reportedAvailable = available;
    this.options.post({ type: "set-app-menu-available", windowId: this.options.windowId, available });
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
