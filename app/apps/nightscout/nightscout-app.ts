import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { nightscoutBridge, type NightscoutState } from "../../native/nightscout-bridge";
import { NightscoutLayer, nightscoutMenuItems } from "./nightscout";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { evaluateNightscoutAlerts } from "./nightscout-alerts";
import { loadNightscoutThresholds, nightscoutAlwaysShowInTopBarSetting, onAnySettingChanged } from "../../ui/dashboard-settings";
import { shell } from "../../ui/shell/shell";

export const NIGHTSCOUT_WINDOW_ID = "nightscout";
export const NIGHTSCOUT_SURFACE_ID = "window:nightscout";

const TRAY_ICON_ID = "nightscout";
const TRAY_HEIGHT = 24;
const TRAY_GRAPH_WIDTH = 48;
const TRAY_STALE_MS = 15 * 60 * 1000;
const TRAY_GRAPH_WINDOW_MS = 2 * 60 * 60 * 1000;

const windowRenders = new Set<() => void>();
let trayStarted = false;
let trayTick: ReturnType<typeof setInterval> | null = null;

function syncNightscout(): void {
  const visible = windowRenders.size > 0 || nightscoutAlwaysShowInTopBarSetting.get();
  shell.setTrayIcon(TRAY_ICON_ID, visible ? buildNightscoutTrayIcon(nightscoutBridge.snapshot()) : null);
  for (const render of windowRenders) render();
  // Age warnings and stale glucose must advance even during a stalled fetch.
  if (visible && trayTick === null) trayTick = setInterval(syncNightscout, 60_000);
  if (!visible && trayTick !== null) {
    clearInterval(trayTick);
    trayTick = null;
  }
}

/** Shell-lifetime subscription so the tray can be enabled before any window opens. */
export function startNightscoutTrayIcon(): void {
  if (trayStarted) return;
  trayStarted = true;
  nightscoutBridge.onStateChange(syncNightscout);
  onAnySettingChanged(syncNightscout);
}

/** Full-screen glucose view with a shared, optionally persistent tray readout. */
export function createNightscoutAppWindow(options: InProcessAppOptions): InProcessWindow {
  startNightscoutTrayIcon();
  const render = () => app.requestRender();
  const app = createInProcessWindow({
    appId: "nightscout",
    windowId: NIGHTSCOUT_WINDOW_ID,
    title: "Nightscout",
    iconLetter: "Ns",
    icon: "nightscout",
    closeable: true,
    menuItems: nightscoutMenuItems,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new NightscoutLayer()),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      windowRenders.delete(render);
      syncNightscout();
      options.onClosed();
    },
  });
  windowRenders.add(render);
  syncNightscout();
  return app;
}

/** BG value, 2-hour graph, then a warning triangle when any threshold is breached. */
function buildNightscoutTrayIcon(state: NightscoutState): GrayImage {
  const font = getDefaultSmallFont();
  const nowMs = Date.now();
  const label = state.latest ? `${state.latest.sgv}` : "--";
  const labelWidth = font.measureText(label);
  const warning = evaluateNightscoutAlerts(state, loadNightscoutThresholds(), nowMs).any;
  const graphEnd = labelWidth + 4 + TRAY_GRAPH_WIDTH;
  const image = new GrayImage(graphEnd + (warning ? 24 : 0), TRAY_HEIGHT, 0);

  const textY = Math.max(0, ((TRAY_HEIGHT - font.lineHeight) / 2) | 0);
  image.drawText(font, 0, textY, label, 220);
  const stale = state.latest !== null && nowMs - state.latest.timestampMs > TRAY_STALE_MS;
  if (stale) {
    image.drawLine(0, TRAY_HEIGHT / 2, labelWidth, TRAY_HEIGHT / 2, 180);
  }

  drawTrayGraph(image, labelWidth + 4, state, nowMs);
  if (warning) {
    const x = graphEnd + 4;
    image.drawLine(x + 9, 3, x, 20, 255);
    image.drawLine(x, 20, x + 18, 20, 255);
    image.drawLine(x + 18, 20, x + 9, 3, 255);
    image.fillRect(x + 8, 9, 2, 6, 255);
    image.fillRect(x + 8, 17, 2, 2, 255);
  }
  return image;
}

function drawTrayGraph(image: GrayImage, x: number, state: NightscoutState, nowMs: number): void {
  const windowStartMs = nowMs - TRAY_GRAPH_WINDOW_MS;
  const points = state.history.filter(
    (point) => point.timestampMs >= windowStartMs && point.timestampMs <= nowMs,
  );
  if (points.length === 0) return;

  const values = points.map((point) => point.sgv);
  const min = Math.min(...values, 60);
  const max = Math.max(...values, 200);
  const span = Math.max(20, max - min);

  const plotted = points.map((point) => ({
    timestampMs: point.timestampMs,
    x: x + Math.round(((point.timestampMs - windowStartMs) / TRAY_GRAPH_WINDOW_MS) * (TRAY_GRAPH_WIDTH - 1)),
    y: TRAY_HEIGHT - 1 - Math.round(((point.sgv - min) / span) * (TRAY_HEIGHT - 1)),
  }));
  for (let index = 1; index < plotted.length; index++) {
    const previous = plotted[index - 1]!;
    const current = plotted[index]!;
    if (current.timestampMs - previous.timestampMs <= TRAY_STALE_MS) {
      image.drawLine(previous.x, previous.y, current.x, current.y, 190);
    } else {
      image.fillRect(current.x, current.y, 1, 1, 190);
    }
  }
}
