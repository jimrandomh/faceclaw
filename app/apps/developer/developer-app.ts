import { MenuLayer, submenuItem, type MenuItem } from "../../ui/menu";
import { ScreenTestLayer } from "./screen-test";
import { InputEventsLayer } from "./input-events";
import { shell } from "../../ui/shell/shell";
import { BuzzerDemoLayer } from "./buzzer-demo";
import { AccelerometerDemoLayer } from "./accelerometer-demo";
import { BandwidthBenchmarkLayer } from "./bandwidth-benchmark";
import { LightSensorDemoLayer } from "./light-sensor-demo";
import { MicrophonesMonitorLayer } from "./microphones-monitor";
import { ResourceUsageLayer } from "./resource-usage";
import { RingStatusLayer } from "./ring-status";
import { LoadAppFromQrLayer, LoadAppFromUrlLayer } from "./load-app";
import { unicodeTestMenu } from "./unicode-test";
import { type AppContext } from "../app-definition";
import { appViewportSize } from "../../ui/shell/geometry";
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

type OpenPage = (ctx: Parameters<MenuItem["onSelect"]>[0]) => void;

/** The diagnostic demos, one level down from the root menu. */
function debugTestsMenu(openInputEvents: OpenPage, openMicrophones: OpenPage): MenuLayer {
  return new MenuLayer(
    "Debug tests",
    [
      { label: "Input events", onSelect: openInputEvents },
      {
        label: "Dither test",
        onSelect: (ctx) => {
          ctx.stack.push(new ScreenTestLayer());
        },
      },
      {
        label: "Buzzer demo",
        disabled: global.isIOS,
        description: global.isIOS ? "Glasses sound playback is not available on iOS yet." : undefined,
        onSelect: (ctx) => {
          ctx.stack.push(new BuzzerDemoLayer());
        },
      },
      {
        label: "Accelerometer demo",
        disabled: global.isIOS,
        description: global.isIOS ? "Not available on iOS yet." : undefined,
        onSelect: (ctx) => {
          ctx.stack.push(new AccelerometerDemoLayer(DEVELOPER_WINDOW_ID, ctx.actions.requestRender));
        },
      },
      {
        label: "Light sensor",
        disabled: global.isIOS,
        description: global.isIOS ? "Not available on iOS yet." : undefined,
        onSelect: (ctx) => {
          ctx.stack.push(new LightSensorDemoLayer(DEVELOPER_WINDOW_ID, ctx.actions.requestRender));
        },
      },
      {
        label: "Ring status",
        disabled: global.isIOS,
        description: global.isIOS ? "Not available on iOS yet." : undefined,
        onSelect: (ctx) => {
          ctx.stack.push(new RingStatusLayer(DEVELOPER_WINDOW_ID, ctx.actions.requestRender));
        },
      },
      {
        label: "Microphones",
        disabled: global.isIOS,
        description: global.isIOS ? "Not available on iOS yet." : undefined,
        onSelect: openMicrophones,
      },
      {
        label: "BLE bandwidth",
        onSelect: (ctx) => {
          ctx.stack.push(new BandwidthBenchmarkLayer(ctx.actions.requestRender));
        },
      },
      submenuItem("Unicode test", (ctx) => {
        ctx.stack.push(unicodeTestMenu(MENU_LAYOUT));
      }),
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
  let inputEvents: InputEventsLayer | null = null;
  let microphones: MicrophonesMonitorLayer | null = null;
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
        disabled: global.isIOS,
        description: global.isIOS ? "Not available on iOS yet." : undefined,
        onSelect: (ctx) => {
          ctx.stack.push(new ResourceUsageLayer(DEVELOPER_WINDOW_ID, ctx.actions.requestRender));
        },
      },
      submenuItem("Debug tests", (ctx) => {
        ctx.stack.push(debugTestsMenu((inputCtx) => {
          const page = new InputEventsLayer(inputCtx.actions.requestRender,
            () => shell.isWindowVisible(DEVELOPER_WINDOW_ID),
            () => { if (inputEvents === page) inputEvents = null; });
          inputEvents = page;
          inputCtx.stack.push(page);
        }, (micCtx) => {
          const page = new MicrophonesMonitorLayer(DEVELOPER_WINDOW_ID, micCtx.actions.requestRender,
            () => { if (microphones === page) microphones = null; });
          microphones = page;
          micCtx.stack.push(page);
        }));
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
    menuItems: () => inputEvents?.menuItems() ?? microphones?.menuItems() ?? [],
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
