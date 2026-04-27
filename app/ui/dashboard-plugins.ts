import takeRight from "lodash/takeRight";

import { BdfFont, loadEmbeddedTerminus24 } from "../graphics/bdffont";
import { GrayImage, imageFromAsciiArt } from "../graphics/image";
import { wrapText } from "../graphics/textwrap";
import { mediaControllerBridge, type MediaControllerState } from "../native/media-controller";
import { nightscoutBridge, type NightscoutState } from "../native/nightscout";
import { type DashboardPluginId } from "./dashboard-settings";
import { Layer, type DashboardInputEvent, type LayerContext } from "./layers";

export type DashboardPluginState = {
  logLines: string[];
  media: MediaControllerState;
  nightscout: NightscoutState;
  nightscoutConfigured: boolean;
};

export type DashboardPluginCardBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DashboardPluginCardRenderArgs = {
  image: GrayImage;
  bounds: DashboardPluginCardBounds;
  selected: boolean;
  font: BdfFont;
  state: DashboardPluginState;
};

export interface DashboardPlugin {
  readonly id: DashboardPluginId;
  readonly label: string;
  renderCard(args: DashboardPluginCardRenderArgs): void;
  createFullscreenLayer?(getState: () => DashboardPluginState): Layer | null;
}

const DASHBOARD_PLUGINS: DashboardPlugin[] = [
  {
    id: "blank",
    label: "Blank",
    renderCard: () => {},
    createFullscreenLayer: () => null,
  },
  {
    id: "input-debug-log",
    label: "Input debug log",
    renderCard: ({ image, bounds, font, state }) => {
      image.drawText(font, bounds.x + 10, bounds.y + 14, "Input log", 180);
      const lineHeight = 14;
      const visibleLineCount = Math.max(1, Math.floor((bounds.height - 28) / lineHeight));
      const visibleLines = takeRight(state.logLines, visibleLineCount);
      for (let i = 0; i < visibleLines.length; i++) {
        image.drawText(font, bounds.x + 8, bounds.y + 26 + i * lineHeight, visibleLines[i]!, 190);
      }
    },
    createFullscreenLayer: (getState) => new DebugLogLayer(getState),
  },
  {
    id: "music-controller",
    label: "Music controller",
    renderCard: ({ image, bounds, font, state }) => {
      const media = state.media;
      image.drawText(font, bounds.x + 10, bounds.y + 14, "Now playing", 180);
      if (!media.accessEnabled) {
        image.drawText(font, bounds.x + 10, bounds.y + 30, "Enable notification", 150);
        image.drawText(font, bounds.x + 10, bounds.y + 44, "access for media", 150);
        return;
      }
      if (!media.available) {
        image.drawText(font, bounds.x + 10, bounds.y + 30, "No active session", 150);
        return;
      }

      const titleLines = wrapText(font, media.title || "Unknown title", bounds.width - 20).slice(0, 2);
      const artistLine = media.artist || media.album || media.packageName || "Unknown source";
      image.drawText(font, bounds.x + 10, bounds.y + 30, titleLines[0] ?? "", 210);
      if (titleLines[1]) {
        image.drawText(font, bounds.x + 10, bounds.y + 44, titleLines[1], 210);
      }
      image.drawText(font, bounds.x + 10, bounds.y + 62, artistLine, 160);
      image.drawText(font, bounds.x + 10, bounds.y + bounds.height - 18, playbackLabel(media), 130);
    },
    createFullscreenLayer: (getState) => new MusicControllerLayer(getState),
  },
  {
    id: "nightscout",
    label: "Nightscout",
    renderCard: ({ image, bounds, font, state }) => {
      const nightscout = state.nightscout;
      const nowMs = Date.now();
      image.drawText(font, bounds.x + 10, bounds.y + 10, "Nightscout", 180);
      if (!state.nightscoutConfigured || nightscout.configurationMissing) {
        image.drawText(font, bounds.x + 10, bounds.y + 30, "Needs setup", 170);
        image.drawText(font, bounds.x + 10, bounds.y + 44, "Click to configure", 140);
        return;
      }
      if (!nightscout.available || !nightscout.latest) {
        image.drawText(font, bounds.x + 10, bounds.y + 30, "No glucose data", 150);
        image.drawText(font, bounds.x + 10, bounds.y + 44, truncateLine(nightscout.status, 26), 120);
        return;
      }

      const latest = nightscout.latest;
      const deltaLabel = formatDelta(nightscout.delta);
      const glucoseText = `${latest.sgv}`;
      const glucoseX = bounds.x + bounds.width - 92;
      image.drawText(nightscoutLargeFont, glucoseX, bounds.y + 10, glucoseText, 230);
      if (isNightscoutPointStale(latest, nowMs)) {
        drawNightscoutValueStrikeThrough(image, glucoseX, bounds.y + 22, nightscoutLargeFont.measureText(glucoseText));
      }
      drawNightscoutDelta(image, font, bounds.x + bounds.width - 92, bounds.y + 30, deltaLabel, nightscout.direction, 160);
      image.drawText(
        font,
        bounds.x + 10,
        bounds.y + 30,
        `IOB ${nightscout.iob === null ? "--" : nightscout.iob.toFixed(1)} COB ${nightscout.cob === null ? "--" : formatWholeNumber(nightscout.cob)}`,
        160,
      );
      image.drawText(
        font,
        bounds.x + 10,
        bounds.y + 44,
        `Loop ${nightscout.openapsStatusShort} CAGE ${formatAgeShortFromTimestamp(nightscout.cageTimestampMs, nowMs)}`,
        138,
      );
      drawNightscoutGraph(
        image,
        {
          x: bounds.x + 10,
          y: bounds.y + 60,
          width: bounds.width - 20,
          height: Math.max(16, bounds.height - 82),
        },
        nightscout,
        nowMs,
        font,
      );
    },
    createFullscreenLayer: (getState) => new NightscoutLayer(getState),
  },
];

const PLUGIN_MAP = new Map<DashboardPluginId, DashboardPlugin>(
  DASHBOARD_PLUGINS.map((plugin) => [plugin.id, plugin]),
);
const nightscoutLargeFont = loadEmbeddedTerminus24();
const NIGHTSCOUT_STALE_MS = 15 * 60 * 1000;
const NIGHTSCOUT_GRAPH_WINDOW_MS = 2 * 60 * 60 * 1000;

export function listDashboardPlugins(): DashboardPlugin[] {
  return [...DASHBOARD_PLUGINS];
}

export function getDashboardPlugin(pluginId: DashboardPluginId): DashboardPlugin {
  return PLUGIN_MAP.get(pluginId) ?? PLUGIN_MAP.get("blank")!;
}

export function isBlankDashboardPlugin(pluginId: DashboardPluginId): boolean {
  return pluginId === "blank";
}

function playbackLabel(media: MediaControllerState): string {
  switch (media.playbackState) {
    case "playing":
      return "Playing";
    case "paused":
      return "Paused";
    case "buffering":
      return "Buffering";
    case "stopped":
      return "Stopped";
    case "notification-access-required":
      return "Access required";
    default:
      return media.status || "Idle";
  }
}

function formatDelta(delta: number | null): string {
  if (delta === null) return "--";
  return `${delta >= 0 ? "+" : ""}${Math.round(delta)}`;
}

function drawNightscoutDelta(
  image: GrayImage,
  font: BdfFont,
  x: number,
  y: number,
  deltaLabel: string,
  direction: string,
  shade: number,
): void {
  const text = direction ? `${deltaLabel} ` : deltaLabel;
  image.drawText(font, x, y, text, shade);
  drawDirectionIndicator(image, font, x + font.measureText(text), y, direction, shade);
}

function drawDirectionIndicator(
  image: GrayImage,
  font: BdfFont,
  x: number,
  y: number,
  direction: string,
  shade: number,
): void {
  const label = directionGlyphLabel(font, direction);
  if (label) {
    image.drawText(font, x, y, label, shade);
    return;
  }

  const art = directionAsciiArt(direction);
  if (art) {
    image.bitBlt(imageFromAsciiArt(art, shade), x, y + 1);
    return;
  }

  if (direction) {
    image.drawText(font, x, y, truncateLine(direction, 10), shade);
  }
}

function directionGlyphLabel(font: BdfFont, direction: string): string {
  switch (direction) {
    case "DoubleUp":
      return font.hasGlyph("↑".codePointAt(0)!) ? "↑↑" : "";
    case "SingleUp":
      return font.hasGlyph("↑".codePointAt(0)!) ? "↑" : "";
    case "FortyFiveUp":
      return font.hasGlyph("↗".codePointAt(0)!) ? "↗" : "";
    case "Flat":
      return font.hasGlyph("→".codePointAt(0)!) ? "→" : "";
    case "FortyFiveDown":
      return font.hasGlyph("↘".codePointAt(0)!) ? "↘" : "";
    case "SingleDown":
      return font.hasGlyph("↓".codePointAt(0)!) ? "↓" : "";
    case "DoubleDown":
      return font.hasGlyph("↓".codePointAt(0)!) ? "↓↓" : "";
    default:
      return "";
  }
}

function directionAsciiArt(direction: string): readonly string[] | undefined {
  switch (direction) {
    case "FortyFiveUp":
      return ["   ##", "  ###", " # ##", "#  ##", "   ##"];
    case "FortyFiveDown":
      return ["   ##", "#  ##", " # ##", "  ###", "   ##"];
    default:
      return undefined;
  }
}

function truncateLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatWholeNumber(value: number): string {
  return `${Math.round(value)}`;
}

function formatBolusLabel(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function formatAgeShortFromTimestamp(timestampMs: number | null, nowMs: number): string {
  if (!timestampMs) {
    return "--";
  }
  const elapsedMinutes = Math.max(0, Math.round((nowMs - timestampMs) / 60_000));
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return `${elapsedHours}h`;
  }
  return `${Math.round(elapsedHours / 24)}d`;
}

function drawNightscoutGraph(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  nightscout: NightscoutState,
  nowMs: number,
  font: BdfFont,
): void {
  if (bounds.width <= 2 || bounds.height <= 2) {
    return;
  }

  const windowStartMs = nowMs - NIGHTSCOUT_GRAPH_WINDOW_MS;
  const visibleHistory = nightscout.history.filter((point) => point.timestampMs >= windowStartMs && point.timestampMs <= nowMs);
  if (visibleHistory.length === 0) {
    return;
  }

  const values = visibleHistory.map((point) => point.sgv);
  const min = Math.min(...values, 60);
  const max = Math.max(...values, 200);
  const range = Math.max(20, max - min);
  const paddedMin = min - range * 0.1;
  const paddedMax = max + range * 0.1;

  image.drawRect(bounds.x, bounds.y, bounds.width, bounds.height, 56);
  drawNightscoutBasalOverlay(image, bounds, nightscout.basal, nowMs);
  drawNightscoutReferenceLine(image, bounds, paddedMin, paddedMax, 60, 40);
  drawNightscoutReferenceLine(image, bounds, paddedMin, paddedMax, 100, 40);
  drawNightscoutReferenceLine(image, bounds, paddedMin, paddedMax, 180, 40);

  const plotted = visibleHistory.map((point) => ({
    point,
    x:
      bounds.x +
      Math.round(
        ((point.timestampMs - windowStartMs) / Math.max(1, NIGHTSCOUT_GRAPH_WINDOW_MS)) * Math.max(1, bounds.width - 1),
      ),
    y:
      bounds.y +
      bounds.height -
      1 -
      Math.round(((point.sgv - paddedMin) / Math.max(1, paddedMax - paddedMin)) * Math.max(1, bounds.height - 1)),
  }));

  for (let i = 0; i < plotted.length; i++) {
    const current = plotted[i]!;
    const previous = i > 0 ? plotted[i - 1]! : null;
    const next = i + 1 < plotted.length ? plotted[i + 1]! : null;
    const connectedToPrevious =
      previous !== null && current.point.timestampMs - previous.point.timestampMs <= NIGHTSCOUT_STALE_MS;
    const connectedToNext =
      next !== null && next.point.timestampMs - current.point.timestampMs <= NIGHTSCOUT_STALE_MS;

    if (connectedToPrevious && previous) {
      image.drawLine(previous.x, previous.y, current.x, current.y, 220);
    }
    if (!connectedToPrevious && !connectedToNext) {
      image.fillRect(current.x - 1, current.y - 1, 2, 2, 220);
    }
  }
  drawNightscoutCarbMarkers(image, bounds, font, nightscout.carbs, nowMs);
  drawNightscoutBolusMarkers(image, bounds, font, nightscout.boluses, nowMs);
}

function drawNightscoutBasalOverlay(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  basalEvents: NightscoutState["basal"],
  nowMs: number,
): void {
  const windowStartMs = nowMs - NIGHTSCOUT_GRAPH_WINDOW_MS;
  const visibleEvents = basalEvents.filter(
    (event) => event.timestampMs + event.durationMinutes * 60_000 >= windowStartMs && event.timestampMs <= nowMs,
  );
  if (visibleEvents.length === 0) {
    return;
  }
  const maxRate = Math.max(...visibleEvents.map((event) => event.rate), 0);
  if (maxRate <= 0) {
    return;
  }
  const overlayHeight = Math.max(8, Math.min(18, Math.floor(bounds.height * 0.22)));
  const bottomY = bounds.y + bounds.height - 2;
  for (const event of visibleEvents) {
    const startMs = Math.max(windowStartMs, event.timestampMs);
    const endMs = Math.min(nowMs, event.timestampMs + event.durationMinutes * 60_000);
    if (endMs <= startMs) {
      continue;
    }
    const leftX = timeToGraphX(bounds, windowStartMs, startMs);
    const rightX = timeToGraphX(bounds, windowStartMs, endMs);
    const height = Math.max(1, Math.round((event.rate / maxRate) * overlayHeight));
    image.fillRect(leftX, bottomY - height + 1, Math.max(1, rightX - leftX + 1), height, 18);
  }
}

function drawNightscoutCarbMarkers(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  font: BdfFont,
  carbEvents: NightscoutState["carbs"],
  nowMs: number,
): void {
  const windowStartMs = nowMs - NIGHTSCOUT_GRAPH_WINDOW_MS;
  const baselineY = bounds.y + bounds.height - 2;
  for (const event of carbEvents) {
    if (event.timestampMs < windowStartMs || event.timestampMs > nowMs) {
      continue;
    }
    const x = timeToGraphX(bounds, windowStartMs, event.timestampMs);
    image.drawLine(x, baselineY, x, baselineY - 6, 150);
    drawTextCentered(image, font, x, Math.max(bounds.y + 2, baselineY - 18), `${Math.round(event.carbs)}`, 150, bounds);
  }
}

function drawNightscoutBolusMarkers(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  font: BdfFont,
  bolusEvents: NightscoutState["boluses"],
  nowMs: number,
): void {
  const windowStartMs = nowMs - NIGHTSCOUT_GRAPH_WINDOW_MS;
  const topY = bounds.y + 1;
  for (const event of bolusEvents) {
    if (event.timestampMs < windowStartMs || event.timestampMs > nowMs) {
      continue;
    }
    const x = timeToGraphX(bounds, windowStartMs, event.timestampMs);
    image.drawLine(x, topY, x, topY + 6, 144);
    if (event.insulin >= 1) {
      drawTextCentered(
        image,
        font,
        x,
        Math.min(bounds.y + bounds.height - font.lineHeight - 1, topY + 8),
        formatBolusLabel(event.insulin),
        144,
        bounds,
      );
    }
  }
}

function drawTextCentered(
  image: GrayImage,
  font: BdfFont,
  centerX: number,
  y: number,
  text: string,
  shade: number,
  bounds: { x: number; y: number; width: number; height: number },
): void {
  const textWidth = font.measureText(text);
  const x = Math.max(bounds.x + 1, Math.min(bounds.x + bounds.width - textWidth - 1, centerX - Math.round(textWidth / 2)));
  image.drawText(font, x, y, text, shade);
}

function timeToGraphX(
  bounds: { x: number; y: number; width: number; height: number },
  windowStartMs: number,
  timestampMs: number,
): number {
  return (
    bounds.x +
    Math.round(((timestampMs - windowStartMs) / Math.max(1, NIGHTSCOUT_GRAPH_WINDOW_MS)) * Math.max(1, bounds.width - 1))
  );
}

function drawNightscoutReferenceLine(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  minValue: number,
  maxValue: number,
  value: number,
  shade: number,
): void {
  const y =
    bounds.y +
    bounds.height -
    1 -
    Math.round(((value - minValue) / Math.max(1, maxValue - minValue)) * Math.max(1, bounds.height - 1));
  image.drawLine(bounds.x + 1, y, bounds.x + bounds.width - 2, y, shade);
}

class DebugLogLayer implements Layer {
  private scrollOffset = 0;

  constructor(private readonly getState: () => DashboardPluginState) {}

  paint(ctx: LayerContext): GrayImage {
    const image = new GrayImage(576, 288, 0);
    image.drawRect(12, 12, 552, 264, 52);
    image.drawText(ctx.font, 22, 16, "Input debug log", 220);

    const logs = this.getState().logLines;
    const lineHeight = 14;
    const visibleCount = Math.max(1, Math.floor((288 - 64) / lineHeight));
    const maxOffset = Math.max(0, logs.length - visibleCount);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const start = Math.max(0, maxOffset - this.scrollOffset);
    const visible = logs.slice(start, start + visibleCount);
    for (let index = 0; index < visible.length; index++) {
      image.drawText(ctx.font, 22, 42 + index * lineHeight, visible[index]!, 180);
    }
    image.drawText(ctx.font, 22, 252, "Scroll: browse  Double-click: back", 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
        this.scrollOffset += 1;
        return;
      case "scroll-down":
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }
}

class MusicControllerLayer implements Layer {
  constructor(private readonly getState: () => DashboardPluginState) {}

  paint(ctx: LayerContext): GrayImage {
    const image = new GrayImage(576, 288, 0);
    const media = this.getState().media;
    image.drawRect(12, 12, 552, 264, 52);
    image.drawText(ctx.font, 22, 16, "Music controller", 220);

    if (!media.accessEnabled) {
      const lines = wrapText(
        ctx.font,
        "Notification access is required before Android will expose active media sessions to Faceclaw. Click to open settings.",
        520,
      );
      for (let i = 0; i < lines.length; i++) {
        image.drawText(ctx.font, 22, 44 + i * 14, lines[i]!, 180);
      }
      image.drawText(ctx.font, 22, 252, "Click: open settings  Double-click: back", 110);
      return image;
    }

    if (!media.available) {
      image.drawText(ctx.font, 22, 44, "No active media session.", 180);
      image.drawText(ctx.font, 22, 58, "Start playback in another app,", 180);
      image.drawText(ctx.font, 22, 72, "then reopen this card.", 180);
      image.drawText(ctx.font, 22, 252, "Double-click: back", 110);
      return image;
    }

    image.drawText(ctx.font, 22, 44, media.title || "Unknown title", 220);
    image.drawText(ctx.font, 22, 60, media.artist || media.album || "Unknown artist", 180);
    image.drawText(ctx.font, 22, 76, media.packageName, 130);
    image.drawText(ctx.font, 22, 104, `State: ${playbackLabel(media)}`, 180);
    image.drawText(ctx.font, 22, 132, "Click: play/pause", 180);
    image.drawText(ctx.font, 22, 146, "Scroll up: previous", 180);
    image.drawText(ctx.font, 22, 160, "Scroll down: next", 180);
    image.drawText(ctx.font, 22, 252, "Double-click: back", 110);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    const media = this.getState().media;
    switch (event.type) {
      case "click":
        if (!media.accessEnabled) {
          mediaControllerBridge.openNotificationAccessSettings();
        } else if (media.canPlayPause) {
          await mediaControllerBridge.playPause();
        }
        return;
      case "scroll-up":
        if (media.canSkipPrevious) {
          await mediaControllerBridge.skipPrevious();
        }
        return;
      case "scroll-down":
        if (media.canSkipNext) {
          await mediaControllerBridge.skipNext();
        }
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }
}

class NightscoutLayer implements Layer {
  constructor(private readonly getState: () => DashboardPluginState) {}

  paint(ctx: LayerContext): GrayImage {
    const image = new GrayImage(576, 288, 0);
    const nightscout = this.getState().nightscout;
    const nowMs = Date.now();
    image.drawRect(12, 12, 552, 264, 52);
    image.drawText(ctx.font, 22, 16, "Nightscout", 220);

    if (!this.getState().nightscoutConfigured || nightscout.configurationMissing) {
      image.drawText(ctx.font, 22, 44, "Nightscout needs configuration.", 180);
      image.drawText(ctx.font, 22, 62, "Double-click and use Settings", 140);
      image.drawText(ctx.font, 22, 78, "Integrations > Nightscout.", 140);
      return image;
    }

    if (!nightscout.available || !nightscout.latest) {
      image.drawText(ctx.font, 22, 44, "No Nightscout data available.", 180);
      image.drawText(ctx.font, 22, 58, truncateLine(nightscout.status, 60), 140);
      image.drawText(ctx.font, 22, 252, "Click: refresh  Double-click: back", 110);
      return image;
    }

    const latest = nightscout.latest;
    const glucoseText = `${latest.sgv}`;
    const glucoseX = 22;
    const glucoseWidth = nightscoutLargeFont.measureText(glucoseText);
    image.drawText(nightscoutLargeFont, glucoseX, 28, glucoseText, 230);
    if (isNightscoutPointStale(latest, nowMs)) {
      drawNightscoutValueStrikeThrough(image, glucoseX, 40, glucoseWidth);
    }
    image.drawText(ctx.font, glucoseX + glucoseWidth + 8, 36, nightscout.units, 140);
    const trendText = `Delta ${formatDelta(nightscout.delta)}  Trend `;
    image.drawText(ctx.font, 22, 62, trendText, 180);
    drawDirectionIndicator(image, ctx.font, 22 + ctx.font.measureText(trendText), 62, nightscout.direction, 180);
    image.drawText(
      ctx.font,
      22,
      78,
      `IOB ${nightscout.iob === null ? "--" : nightscout.iob.toFixed(2)}  COB ${nightscout.cob === null ? "--" : formatWholeNumber(nightscout.cob)}  Updated ${formatTimestamp(latest.timestampMs)}`,
      160,
    );
    image.drawText(
      ctx.font,
      22,
      94,
      `CAGE ${formatAgeShortFromTimestamp(nightscout.cageTimestampMs, nowMs)}  Loop ${nightscout.openapsStatusShort}`,
      160,
    );
    image.drawText(ctx.font, 22, 110, `Pump ${truncateLine(nightscout.pumpStatus || "--", 56)}`, 150);
    drawNightscoutGraph(image, { x: 22, y: 128, width: 532, height: 96 }, nightscout, nowMs, ctx.font);
    image.drawText(ctx.font, 22, 234, "2-hour glucose history with basal / carbs / boluses", 130);
    image.drawText(ctx.font, 22, 252, "Click: refresh  Double-click: back", 110);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    switch (event.type) {
      case "click":
        await nightscoutBridge.refreshNow();
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }
}

function formatTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isNightscoutPointStale(point: NightscoutState["latest"], nowMs: number): boolean {
  return point !== null && nowMs - point.timestampMs > NIGHTSCOUT_STALE_MS;
}

function drawNightscoutValueStrikeThrough(image: GrayImage, x: number, y: number, width: number): void {
  image.drawLine(x, y, x + width, y, 180);
}
