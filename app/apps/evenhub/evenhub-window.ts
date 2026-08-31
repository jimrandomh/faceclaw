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
    // Everything goes to the app; long-press never reaches here (the window
    // menu intercepts it), which is the guaranteed way out since EvenHub
    // apps own double-click.
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
    // Glasses-first: the app runs without the phone showing it; this reveals
    // its phone UI (config pages, etc.) over the dashboard on demand.
    menuItems: () => [{ label: "Show phone UI", onSelect: (ctx) => { ctx.stack.pop(); onShowPhone(); } }],
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
