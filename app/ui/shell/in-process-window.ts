import { GrayImage } from "../../graphics/image";
import { type Plane } from "../../graphics/plane";
import * as frameTimings from "../../native/frame-timings";
import { beginRenderPass, endRenderPass } from "../../util/render-freshness";
import { InputEvent } from "../gestures";
import { Layer, LayerActions, LayerContext, LayerStack, PaintBelow } from "../layers";
import { type MenuItem } from "../menu";
import { WindowMenuLayer } from "../window-menu";
import { windowIcon } from "./chrome-layer";
import { type IconName } from "../../graphics/icons";
import { appViewportSize, type WindowHeightMode } from "./geometry";
import { shell, type ShellWindow } from "./shell";

/**
 * A window whose app logic runs on the main thread (launcher, settings):
 * hosts a viewport-sized LayerStack, renders it on input or request, and
 * submits frames through a controller-provided submitter. Java-side dedup
 * finishes no-change frames, so unconditional resubmits keep frame ownership
 * simple.
 */
export type InProcessWindowOptions = {
  appId: string;
  windowId: string;
  title: string;
  iconLetter: string;
  /** Lucide icon name for the sidebar indicator; falls back to iconLetter. */
  icon?: IconName;
  /** App-supplied sidebar icon renderer; takes precedence over icon/iconLetter. */
  drawIcon?: ShellWindow["drawIcon"];
  closeable: boolean;
  /** Window height: the standard 288px band ("min", default) or full screen ("max"). */
  heightMode?: WindowHeightMode;
  /**
   * App-specific entries for the window's long-press menu, listed ahead of
   * the default Voice input / Close window entries. Called at open time, so
   * the items can reflect current app state.
   */
  menuItems?: () => MenuItem[];
  /** Shared actions; requestRender is rebound to this window's render. */
  actions: LayerActions;
  /**
   * Accept text aimed at this window (voice input). Supply it for apps with a
   * layer that takes dictation; leaving it out is what tells the shell not to
   * offer "Type Into App" for this window.
   */
  receiveTextInput?: (text: string) => void;
  /** Input focus moved into this window (see ShellWindow.onFocus). */
  onFocus?: ShellWindow["onFocus"];
  baseLayer: Layer;
  submitFrame: (planes: Plane[], paintMs: number, frameId: number) => Promise<void>;
  setSurfaceVisible: (visible: boolean) => void;
  removeSurface?: () => void;
  /** Resize this window's compositor surface after a height-mode change. */
  reconfigureSurface?: (heightMode: WindowHeightMode) => void;
  onClosed?: () => void;
};

export type InProcessWindow = {
  window: ShellWindow;
  stack: LayerStack;
  requestRender: () => void;
  /** Change the window's height band at runtime (resizes the viewport + surface). */
  setHeightMode: (mode: WindowHeightMode) => void;
};

/** The controller-provided plumbing common to every in-process app window. */
export type InProcessAppOptions = {
  actions: LayerActions;
  submitFrame: (planes: Plane[], paintMs: number, frameId: number) => Promise<void>;
  setSurfaceVisible: (visible: boolean) => void;
  removeSurface: () => void;
  reconfigureSurface?: (heightMode: WindowHeightMode) => void;
  onClosed: () => void;
};

export function createInProcessWindow(options: InProcessWindowOptions): InProcessWindow {
  /**
   * Repaint under a new frame. causeFrameId links it to the frame that made it
   * necessary (a stale-cache paint asking for a redo); 0 for an app-initiated
   * repaint. Each repaint gets a frame either way: an app-initiated one (a
   * clock tick, arriving data) is a real screen update with real latency, and
   * submitting it under frame 0 made it invisible in the timing export except
   * as an anonymous "superseded by frame#0" line in some other frame's log.
   */
  const renderInNewFrame = (causeFrameId: number) => {
    void render(frameTimings.startFrame(`render:${options.windowId}`, causeFrameId)).catch((error) => {
      console.error(`${options.windowId} render failed: ${error}`);
    });
  };
  // Handed to app code as a bare callback, so it takes no arguments.
  const requestRender = () => renderInNewFrame(0);
  let heightMode = options.heightMode ?? "min";
  const stack = new LayerStack(
    options.baseLayer,
    { ...options.actions, requestRender },
    appViewportSize(heightMode),
    () => shell.isWindowFocused(options.windowId),
  );

  // Data sources with caches (e.g. notification icons) may serve stale data
  // to keep the paint fast; when they do, schedule one follow-up render that
  // requires fresh data (same contract as the dashboard render loop).
  let nextRenderWantsFreshData = false;
  let closed = false;

  async function render(frameId: number): Promise<void> {
    if (closed) {
      // The surface is gone (e.g. Close window picked from this window's own
      // menu); dropping the frame beats submitting to a removed surface.
      frameTimings.finishFrame(frameId, "discarded: window closed");
      return;
    }
    frameTimings.annotateFrame(frameId, `window=${options.windowId}`);
    const wantFreshData = nextRenderWantsFreshData;
    nextRenderWantsFreshData = false;
    beginRenderPass(!wantFreshData);
    const paintStartedAtMs = Date.now();
    // runWithFrame so leaf data sources (notification icons, calendar) attach
    // their own spans to this frame.
    const planes = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => stack.paint()),
    );
    const paintUsedStaleData = endRenderPass();
    await options.submitFrame(planes, Date.now() - paintStartedAtMs, frameId);
    if (paintUsedStaleData) {
      nextRenderWantsFreshData = true;
      renderInNewFrame(frameId);
    }
  }

  // The window's long-press menu: app-specific items, then the defaults every
  // window shares. In-process apps run on the main thread, so the default
  // items act on the shell directly (workers post messages instead).
  const openWindowMenu = () => {
    if (stack.topMatches((layer) => layer instanceof WindowMenuLayer)) return;
    // "Focus app switcher" first: long-press then tap defocuses the app
    // (hands focus to the sidebar) without closing it — the reliable way out
    // for apps that consume double-click.
    const items: MenuItem[] = [
      {
        label: "Focus app switcher",
        onSelect: (ctx) => {
          ctx.stack.pop();
          shell.yieldFocusToSidebar();
        },
      },
      ...(options.menuItems?.() ?? []),
    ];
    items.push({
      label: "Voice input",
      onSelect: (ctx) => {
        ctx.stack.pop();
        shell.startVoiceInput();
      },
    });
    if (options.closeable) {
      items.push({
        label: "Close window",
        onSelect: (ctx) => {
          ctx.stack.pop();
          shell.closeWindow(options.windowId);
        },
      });
    }
    stack.push(new WindowMenuLayer(items));
  };

  const window: ShellWindow = {
    appId: options.appId,
    windowId: options.windowId,
    title: options.title,
    surfaceId: `window:${options.windowId}`,
    closeable: options.closeable,
    // The window's own LayerStack decides per layer whether a swipe is
    // directional or falls back to click / double-click.
    acceptsDirectional: true,
    heightMode,
    close: () => {
      closed = true;
      // Fire onRemoved for any pushed layers so they release resources (e.g. a
      // demo that enabled a hardware stream) even when closed from within.
      stack.clearToBase();
      options.onClosed?.();
      options.removeSurface?.();
    },
    drawIcon: options.drawIcon ?? windowIcon(options.icon, options.iconLetter),
    handleInput: async (event, frameId) => {
      // The default long-press response: the window menu. Handled here (not
      // per-layer) so it works over submenus and app content alike.
      if (event.type === "long-press") {
        openWindowMenu();
        await render(frameId);
        return;
      }
      // Spanned separately from the paint: an app's input handler may await
      // real work (launching an app, a network call), and that used to show up
      // as a bare multi-second gap inside the shell's handle-input span.
      await frameTimings.spanAsync(frameId, `app-input:${options.windowId}`, () =>
        stack.handleInput(event),
      );
      await render(frameId);
    },
    requestRender,
    relayout: () => {
      stack.setBaseSize(appViewportSize(heightMode));
      options.reconfigureSurface?.(heightMode);
      requestRender();
    },
    hitTest: async (x, y) => {
      const handled = await stack.hitTest(x, y);
      if (handled) requestRender();
      return handled;
    },
    receiveTextInput: options.receiveTextInput,
    onFocus: options.onFocus,
    setForeground: (foreground) => {
      options.setSurfaceVisible(foreground);
    },
  };
  const setHeightMode = (mode: WindowHeightMode) => {
    if (heightMode === mode) return;
    heightMode = mode;
    window.heightMode = mode;
    stack.setBaseSize(appViewportSize(mode));
    options.reconfigureSurface?.(mode);
    requestRender();
  };
  return { window, stack, requestRender, setHeightMode };
}

/**
 * Wrap an app's root layer so double-click at the root yields focus to the
 * shell sidebar (the standard leave-the-app gesture) instead of being
 * swallowed by the layer's own back handling.
 */
export class YieldAtRootLayer implements Layer {
  constructor(private readonly inner: Layer) {}

  get paintOverBase(): boolean | undefined {
    return this.inner.paintOverBase;
  }

  /** Directional swipes reach the inner layer only if it understands them. */
  get acceptsDirectional(): boolean | undefined {
    return this.inner.acceptsDirectional;
  }

  hitTest(x: number, y: number, ctx: LayerContext): Promise<boolean> | boolean {
    return this.inner.hitTest ? this.inner.hitTest(x, y, ctx) : false;
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    return this.inner.paint(ctx, paintBelow);
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      shell.yieldFocusToSidebar();
      return;
    }
    await this.inner.handleInput(event, ctx);
  }

  onRemoved(): void {
    this.inner.onRemoved?.();
  }
}
