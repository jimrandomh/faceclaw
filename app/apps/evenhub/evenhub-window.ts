/**
 * The glasses-side window for a running EvenHub app: a layer that paints the
 * session's composited page and forwards gestures to it. heightMode "medium"
 * makes the content area exactly the 576x288 surface EvenHub apps expect.
 */
import { GrayImage } from "../../graphics/image";
import { EVENHUB_SCREEN_WIDTH } from "./compositor";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import {
  createInProcessWindow,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { makeImageWindowIcon, windowIcon } from "../../ui/shell/chrome-layer";
import { EvenHubSession } from "./session";
import { renderInstalledEvenHubIcon } from "./installed-apps";

class EvenHubAppLayer implements Layer {
  constructor(private readonly session: EvenHubSession) {}

  paint(ctx: LayerContext): GrayImage {
    const size = ctx.stack.getBaseSize();
    // EvenHub apps lay out for the stock 576-wide surface. In the full-panel
    // display mode the window is 640 wide; paint at stock width and centre
    // it rather than leaving all the slack on the right.
    if (size.width > EVENHUB_SCREEN_WIDTH) {
      const content = this.session.paint({ width: EVENHUB_SCREEN_WIDTH, height: size.height }, ctx.stack.isFocused());
      const image = new GrayImage(size.width, size.height, 0);
      content.composeInto(image, Math.floor((size.width - EVENHUB_SCREEN_WIDTH) / 2), 0);
      return image;
    }
    return this.session.paint(size, ctx.stack.isFocused());
  }

  handleInput(event: InputEvent): void {
    // Everything goes to the app; the menu gestures never reach here (the
    // shell keeps long-press for its system menu and the window's context
    // menu intercepts tap-then-hold), which is the guaranteed way out since
    // EvenHub apps own double-click. Tap-then-hold is still reported to the
    // app as LONG_PRESS_EVENT — see the handleInput wrapper below.
    this.session.handleGesture(event);
  }
}

export function createEvenHubWindow(
  windowId: string,
  appId: string,
  session: EvenHubSession,
  options: InProcessAppOptions,
  onShowPhone: () => void,
): InProcessWindow {
  const fallbackIcon = windowIcon("package", session.manifest.name.charAt(0).toUpperCase() || "E");
  const created = createInProcessWindow({
    appId,
    windowId,
    title: session.manifest.name,
    iconLetter: session.manifest.name.charAt(0).toUpperCase() || "E",
    closeable: true,
    drawIcon: makeImageWindowIcon(
      (size) => renderInstalledEvenHubIcon(session.manifest.packageId, size),
      fallbackIcon,
    ),
    heightMode: "medium",
    // The window's context menu doubles as the OS contextual menu EvenHub
    // apps register with `menuObject` (SDK 0.0.14): the app's own entries come
    // first, then the host entries. Evaluated at open time, so a rebuild that
    // changes or clears the menu is reflected on the next press.
    menuItems: () => [
      ...session.contextMenuItems().map((item) => ({
        label: item.itemName,
        onSelect: (ctx: LayerContext) => {
          ctx.stack.pop();
          session.selectContextMenuItem(item.itemID);
        },
      })),
      // Glasses-first: the app runs without the phone showing it; this reveals
      // its phone UI (config pages, etc.) over the dashboard on demand.
      { label: "Show phone UI", onSelect: (ctx: LayerContext) => { ctx.stack.pop(); onShowPhone(); } },
    ],
    actions: options.actions,
    baseLayer: new EvenHubAppLayer(session),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    reconfigureSurface: options.reconfigureSurface,
    onClosed: () => {
      options.onClosed();
      session.windowClosed();
    },
  });

  session.attachWindow({
    requestRender: created.requestRender,
    closeWindow: () => shell.closeWindow(windowId),
    focusSwitcher: () => shell.yieldFocusToSidebar(),
    pushOverlay: (layer) => created.stack.push(layer),
    // The extended layout uses the full 576x452 app area ("max"); stock apps
    // stay in the 576x288 band ("medium").
    setTallCanvas: (tall) => created.setHeightMode(tall ? "max" : "medium"),
    windowId,
  });

  // LONG_PRESS_EVENT / LONG_PRESS_RELEASE_EVENT (SDK 0.0.14): the app hears
  // the context-menu gesture (tap-then-hold; a plain long-press is the
  // shell's and never arrives) as its long-press. Wrapped at the window
  // rather than handled in the base layer because the press opens the window
  // menu and so never reaches a layer, and because the release lands on that
  // menu once it is up.
  const baseHandleInput = created.window.handleInput;
  created.window.handleInput = async (event, frameId) => {
    if (event.type === "short-then-long-press" || event.type === "long-press-release") {
      session.handleGesture(event);
    }
    await baseHandleInput(event, frameId);
  };

  // FOREGROUND_ENTER/EXIT for the app on shell focus changes.
  const baseSetForeground = created.window.setForeground;
  created.window.setForeground = (foreground) => {
    baseSetForeground?.(foreground);
    session.setForeground(foreground);
  };

  // Screen on/off gates the app's microphone (silent while the screen is off).
  const baseSetScreenOn = created.window.setScreenOn;
  created.window.setScreenOn = (on) => {
    baseSetScreenOn?.(on);
    session.setScreenOn(on);
  };

  return created;
}
