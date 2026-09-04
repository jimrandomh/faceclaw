import { MenuLayer, drawSubmenuIndicator, type MenuItem } from "../../ui/menu";
import { ScreenTestLayer } from "./screen-test";
import { BuzzerDemoLayer } from "./buzzer-demo";
import { AccelerometerDemoLayer } from "./accelerometer-demo";
import { LightSensorDemoLayer } from "./light-sensor-demo";
import { ResourceUsageLayer } from "./resource-usage";
import { LoadAppFromQrLayer, LoadAppFromUrlLayer } from "./load-app";
import { type AppContext } from "../app-definition";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { appViewportSize } from "../../ui/shell/geometry";
import { LIST_ROW_TEXT_INSET } from "../../ui/metrics";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";

export const DEVELOPER_WINDOW_ID = "developer";
export const DEVELOPER_SURFACE_ID = "window:developer";

const MENU_LAYOUT = {
  x: 8,
  y: 8,
  width: 272,
  showBorder: false,
  minHeight: 0,
  maxHeight: appViewportSize("min").height - 16,
  // These menus are pages, not popups: "Debug tests" replaces the root menu
  // visually instead of letting the taller root show through beneath it.
  opaque: true,
};

/** A row that opens a nested page: the label plus a right-edge ">". */
function submenuItem(label: string, onSelect: MenuItem["onSelect"]): MenuItem {
  return {
    label,
    onSelect,
    render: ({ image, x, y, width, height, selected, disabled, text }) => {
      const font = getDefaultSmallFont();
      const value = disabled ? 70 : selected ? 255 : 200;
      image.drawText(font, x, y + LIST_ROW_TEXT_INSET, text, value);
      drawSubmenuIndicator(image, font, x, y, width, height, value);
    },
  };
}

/** The diagnostic demos, one level down from the root menu. */
function debugTestsMenu(): MenuLayer {
  return new MenuLayer(
    "Debug tests",
    [
      {
        label: "Dither test",
        onSelect: (ctx) => {
          ctx.stack.push(new ScreenTestLayer());
        },
      },
      {
        label: "Buzzer demo",
        onSelect: (ctx) => {
          ctx.stack.push(new BuzzerDemoLayer());
        },
      },
      {
        label: "Accelerometer demo",
        onSelect: (ctx) => {
          ctx.stack.push(new AccelerometerDemoLayer(DEVELOPER_WINDOW_ID, ctx.actions.requestRender));
        },
      },
      {
        label: "Light sensor",
        onSelect: (ctx) => {
          ctx.stack.push(new LightSensorDemoLayer(DEVELOPER_WINDOW_ID, ctx.actions.requestRender));
        },
      },
    ],
    MENU_LAYOUT,
  );
}

/**
 * The Developer app: tools for building and debugging on the glasses. The two
 * "Load app" entries run an EvenHub app straight off a web server, without
 * packaging it into an .ehpk first; the diagnostic demos live one level down
 * under "Debug tests".
 */
export function createDeveloperAppWindow(appContext: AppContext, options: InProcessAppOptions): InProcessWindow {
  const menu = new MenuLayer(
    "Developer",
    [
      {
        label: "Load app from URL",
        onSelect: (ctx) => {
          const layer = new LoadAppFromUrlLayer(appContext);
          ctx.stack.push(layer);
          layer.open(ctx);
        },
      },
      {
        label: "Load app from QR code",
        onSelect: (ctx) => {
          const layer = new LoadAppFromQrLayer(appContext);
          ctx.stack.push(layer);
          layer.open(ctx);
        },
      },
      {
        label: "Show resource usage",
        onSelect: (ctx) => {
          ctx.stack.push(new ResourceUsageLayer(DEVELOPER_WINDOW_ID, ctx.actions.requestRender));
        },
      },
      submenuItem("Debug tests", (ctx) => {
        ctx.stack.push(debugTestsMenu());
      }),
    ],
    MENU_LAYOUT,
  );
  let created: InProcessWindow | null = null;
  created = createInProcessWindow({
    appId: "developer",
    windowId: DEVELOPER_WINDOW_ID,
    title: "Developer",
    iconLetter: "Dv",
    icon: "wrench",
    closeable: true,
    actions: options.actions,
    // Dictating a URL is the one thing worth speaking at in this app; the
    // load pages take the text and every other page ignores it.
    receiveTextInput: (text) => {
      if (created?.stack.receiveTextInput(text)) created.requestRender();
    },
    baseLayer: new YieldAtRootLayer(menu),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
  return created;
}
