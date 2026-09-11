import { GrayImage } from "../../graphics/image";
import { enumSettingMenuItem, toggleSettingMenuItem } from "../../ui/dashboard-settings";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext, type PaintBelow } from "../../ui/layers";
import { MenuLayer, type MenuItem } from "../../ui/menu";
import { createInProcessWindow, YieldAtRootLayer, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";
import { GlanceBoard } from "./board";
import { glanceboardEnabledSetting, glanceSlotSettings } from "./glanceboard-settings";
import { QUADRANT_LAYOUT } from "./layout";

export const GLANCEBOARD_WINDOW_ID = "glanceboard";
export const GLANCEBOARD_SURFACE_ID = "window:glanceboard";

/**
 * The Glanceboard app window: where the board is configured. A list of the
 * layout's slots (each a widget picker), the sleep-gesture toggle, and a
 * live preview of the board as it will look when glanced at.
 */
class GlanceboardConfigLayer implements Layer {
  private menu: MenuLayer | null = null;

  private currentMenu(ctx: LayerContext): MenuLayer {
    if (!this.menu) {
      const { width } = ctx.stack.getBaseSize();
      const items: MenuItem[] = [
        {
          label: "Preview",
          description: "Show the board as it appears when the display is asleep and tapped.",
          onSelect: (menuCtx) => menuCtx.stack.push(new GlancePreviewLayer(() => menuCtx.actions.requestRender())),
        },
        ...glanceSlotSettings(QUADRANT_LAYOUT).map((setting) => enumSettingMenuItem(setting)),
        toggleSettingMenuItem(glanceboardEnabledSetting),
      ];
      this.menu = new MenuLayer("Glanceboard", items, {
        x: 8, y: 8, width: width - 16,
        opaque: true, showBorder: false,
        footer: "Asleep: tap shows, hold keeps, double-tap wakes",
      });
    }
    return this.menu;
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    return this.currentMenu(ctx).paint(ctx, paintBelow);
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    await this.currentMenu(ctx).handleInput(event, ctx);
  }
}

/** The live board in the window; any click or double-click returns to the list. */
class GlancePreviewLayer implements Layer {
  private readonly board: GlanceBoard;

  constructor(requestRender: () => void) {
    this.board = new GlanceBoard(requestRender);
    this.board.start();
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const board = this.board.paint();
    if (board.width === width && board.height === height) return board;
    // A viewport of another size (a per-app display override) shows the board
    // top-left, cropped or padded, rather than scaled.
    const image = new GrayImage(width, height, 0);
    board.composeInto(image, 0, 0);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "click" || event.type === "double-click") ctx.stack.pop();
  }

  onRemoved(): void {
    this.board.stop();
  }
}

export function createGlanceboardAppWindow(options: InProcessAppOptions): InProcessWindow {
  return createInProcessWindow({
    appId: "glanceboard",
    windowId: GLANCEBOARD_WINDOW_ID,
    title: "Glanceboard",
    iconLetter: "Gb",
    icon: "eye",
    closeable: true,
    // 576x288: the board's own size, so the preview is pixel-exact.
    heightMode: "medium",
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new GlanceboardConfigLayer()),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    reconfigureSurface: options.reconfigureSurface,
    onClosed: options.onClosed,
  });
}
