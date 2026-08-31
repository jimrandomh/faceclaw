import { getDefaultLargeFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { InputEvent } from "../../ui/gestures";
import { Layer, LayerContext } from "../../ui/layers";
import { nightscoutBridge, type NightscoutState } from "../../native/nightscout-bridge";
import {
  isNightscoutSettingsConfigured,
  nightscoutApiTokenSetting,
  nightscoutSiteUrlSetting,
  textSettingMenuItem,
} from "../../ui/dashboard-settings";
import { formatAgeShortFromTimestamp, formatTimestamp } from "~/util/date-util";
import { type MenuItem } from "../../ui/menu";
import { openSettingsSubMenu } from "../../ui/dashboard/settings-panel";
import { lineStep } from "../../ui/metrics";

const nightscoutLargeFont = getDefaultLargeFont();
const NIGHTSCOUT_STALE_MS = 15 * 60 * 1000;
const NIGHTSCOUT_GRAPH_WINDOW_MS = 2 * 60 * 60 * 1000;
const NIGHTSCOUT_GRAPH_TIME_QUANTUM_MS = 60 * 1000;

function drawDirectionIndicator(
  image: GrayImage,
  font: UiFont,
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

  if (direction) {
    image.drawText(font, x, y, truncateLine(direction, 10), shade);
  }
}

/**
 * The trend as unicode arrows (U+2191..U+2198), drawn as ordinary text so
 * they scale with the font. A bitmap face missing a diagonal falls back to
 * the vertical arrow; a face with no arrows at all falls back to the raw
 * direction text in drawDirectionIndicator.
 */
function directionGlyphLabel(font: UiFont, direction: string): string {
  const pick = (...candidates: string[]): string => {
    for (const candidate of candidates) {
      if (font.hasGlyph(candidate.codePointAt(0)!)) return candidate;
    }
    return "";
  };
  switch (direction) {
    case "DoubleUp":
      return pick("↑").repeat(2);
    case "SingleUp":
      return pick("↑");
    case "FortyFiveUp":
      return pick("↗", "↑");
    case "Flat":
      return pick("→");
    case "FortyFiveDown":
      return pick("↘", "↓");
    case "SingleDown":
      return pick("↓");
    case "DoubleDown":
      return pick("↓").repeat(2);
    default:
      return "";
  }
}

function truncateLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatDelta(delta: number | null): string {
  if (delta === null) return "--";
  return `${delta >= 0 ? "+" : ""}${Math.round(delta)}`;
}

function formatWholeNumber(value: number): string {
  return `${Math.round(value)}`;
}

function formatBolusLabel(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function drawNightscoutGraph(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  nightscout: NightscoutState,
  nowMs: number,
  font: UiFont,
): void {
  if (bounds.width <= 2 || bounds.height <= 2) {
    return;
  }

  const graphNowMs = minuteBucketTimestampMs(nowMs);
  const windowStartMs = graphNowMs - NIGHTSCOUT_GRAPH_WINDOW_MS;
  const visibleHistory = nightscout.history.filter((point) => {
    const pointTimestampMs = minuteBucketTimestampMs(point.timestampMs);
    return pointTimestampMs >= windowStartMs && pointTimestampMs <= graphNowMs;
  });
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
  drawNightscoutBasalOverlay(image, bounds, nightscout.basal, graphNowMs);
  drawNightscoutReferenceLine(image, bounds, paddedMin, paddedMax, 60, 40);
  drawNightscoutReferenceLine(image, bounds, paddedMin, paddedMax, 100, 40);
  drawNightscoutReferenceLine(image, bounds, paddedMin, paddedMax, 180, 40);

  const plotted = visibleHistory.map((point) => ({
    point,
    x: timeToGraphX(bounds, windowStartMs, point.timestampMs),
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
  drawNightscoutCarbMarkers(image, bounds, font, nightscout.carbs, graphNowMs);
  drawNightscoutBolusMarkers(image, bounds, font, nightscout.boluses, graphNowMs);
}

function drawNightscoutBasalOverlay(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  basalEvents: NightscoutState["basal"],
  nowMs: number,
): void {
  const graphNowMs = minuteBucketTimestampMs(nowMs);
  const windowStartMs = graphNowMs - NIGHTSCOUT_GRAPH_WINDOW_MS;
  const visibleEvents = basalEvents.filter(
    (event) =>
      minuteBucketTimestampMs(event.timestampMs + event.durationMinutes * 60_000) >= windowStartMs &&
      minuteBucketTimestampMs(event.timestampMs) <= graphNowMs,
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
    const startMs = Math.max(windowStartMs, minuteBucketTimestampMs(event.timestampMs));
    const endMs = Math.min(graphNowMs, minuteBucketTimestampMs(event.timestampMs + event.durationMinutes * 60_000));
    if (endMs <= startMs) {
      continue;
    }
    const leftX = timeToGraphX(bounds, windowStartMs, startMs);
    const rightX = timeToGraphX(bounds, windowStartMs, endMs);
    const height = Math.max(1, Math.round((event.rate / maxRate) * overlayHeight));
    image.fillRect(leftX, bottomY - height + 1, Math.max(1, rightX - leftX + 1), height, 15);
  }
}

function drawNightscoutCarbMarkers(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  font: UiFont,
  carbEvents: NightscoutState["carbs"],
  nowMs: number,
): void {
  const graphNowMs = minuteBucketTimestampMs(nowMs);
  const windowStartMs = graphNowMs - NIGHTSCOUT_GRAPH_WINDOW_MS;
  const baselineY = bounds.y + bounds.height - 2;
  for (const event of carbEvents) {
    const eventTimestampMs = minuteBucketTimestampMs(event.timestampMs);
    if (eventTimestampMs < windowStartMs || eventTimestampMs > graphNowMs) {
      continue;
    }
    const x = timeToGraphX(bounds, windowStartMs, eventTimestampMs);
    image.drawLine(x, baselineY, x, baselineY - 6, 150);
    drawTextCentered(image, font, x, Math.max(bounds.y + 2, baselineY - 18), `${Math.round(event.carbs)}`, 150, bounds);
  }
}

function drawNightscoutBolusMarkers(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  font: UiFont,
  bolusEvents: NightscoutState["boluses"],
  nowMs: number,
): void {
  const graphNowMs = minuteBucketTimestampMs(nowMs);
  const windowStartMs = graphNowMs - NIGHTSCOUT_GRAPH_WINDOW_MS;
  const topY = bounds.y + 1;
  for (const event of bolusEvents) {
    const eventTimestampMs = minuteBucketTimestampMs(event.timestampMs);
    if (eventTimestampMs < windowStartMs || eventTimestampMs > graphNowMs) {
      continue;
    }
    const x = timeToGraphX(bounds, windowStartMs, eventTimestampMs);
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
  font: UiFont,
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
  const graphTimestampMs = minuteBucketTimestampMs(timestampMs);
  return (
    bounds.x +
    Math.round(
      ((graphTimestampMs - windowStartMs) / Math.max(1, NIGHTSCOUT_GRAPH_WINDOW_MS)) * Math.max(1, bounds.width - 1),
    )
  );
}

function minuteBucketTimestampMs(timestampMs: number): number {
  return Math.floor(timestampMs / NIGHTSCOUT_GRAPH_TIME_QUANTUM_MS) * NIGHTSCOUT_GRAPH_TIME_QUANTUM_MS;
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


export class NightscoutLayer implements Layer {
  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    // Sized to the hosting stack (the Nightscout app viewport).
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const nightscout = nightscoutBridge.snapshot();
    const nowMs = Date.now();
    const step = lineStep(font);
    image.drawText(font, 22, 16, "Nightscout", 220);

    if (!isNightscoutSettingsConfigured() || nightscout.configurationMissing) {
      image.drawText(font, 22, 44, "Nightscout needs configuration.", 180);
      image.drawText(font, 22, 44 + step, "Long-press for the menu, then pick Settings to set", 140);
      image.drawText(font, 22, 44 + 2 * step, "the site URL and API token.", 140);
      return image;
    }

    if (!nightscout.available || !nightscout.latest) {
      image.drawText(font, 22, 44, "No Nightscout data available.", 180);
      image.drawText(font, 22, 44 + step, truncateLine(nightscout.status, 60), 140);
      return image;
    }

    // Two-column header above the graph: title + current glucose on the
    // left, the status lines bottom-aligned on the right.
    const graphTop = 128;
    const latest = nightscout.latest;
    const glucoseText = `${latest.sgv}`;
    const glucoseX = 22;
    const glucoseWidth = nightscoutLargeFont.measureText(glucoseText);
    // Glucose value vertically centered between the title and the graph.
    const titleBottom = 16 + font.lineHeight;
    const glucoseY = Math.round((titleBottom + graphTop - nightscoutLargeFont.lineHeight) / 2);
    image.drawText(nightscoutLargeFont, glucoseX, glucoseY, glucoseText, 230);
    if (isNightscoutPointStale(latest, nowMs)) {
      drawNightscoutValueStrikeThrough(image, glucoseX, glucoseY + (nightscoutLargeFont.lineHeight >> 1), glucoseWidth);
    }
    image.drawText(font, glucoseX + glucoseWidth + 8, glucoseY + nightscoutLargeFont.lineHeight - font.lineHeight, nightscout.units, 140);

    const statusX = 170;
    const statusWidth = width - 22 - statusX;
    const statusLines: { text: string; shade: number; direction?: string }[] = [
      { text: `Delta ${formatDelta(nightscout.delta)}  Trend `, shade: 180, direction: nightscout.direction },
      {
        text: `IOB ${nightscout.iob === null ? "--" : nightscout.iob.toFixed(2)}  COB ${nightscout.cob === null ? "--" : formatWholeNumber(nightscout.cob)}  Updated ${formatTimestamp(latest.timestampMs)}`,
        shade: 160,
      },
      {
        text: `CAGE ${formatAgeShortFromTimestamp(nightscout.cageTimestampMs, nowMs)}  Loop ${nightscout.openapsStatusShort}`,
        shade: 160,
      },
      { text: `Pump ${nightscout.pumpStatus || "--"}`, shade: 150 },
    ];
    let statusY = graphTop - 8 - statusLines.length * step;
    for (const line of statusLines) {
      if (line.direction !== undefined) {
        image.drawText(font, statusX, statusY, line.text, line.shade);
        drawDirectionIndicator(image, font, statusX + font.measureText(line.text), statusY, line.direction, line.shade);
      } else {
        image.drawText(font, statusX, statusY, truncateText(font, line.text, statusWidth), line.shade);
      }
      statusY += step;
    }

    const captionY = height - font.lineHeight - 6;
    const graphHeight = Math.max(40, captionY - 6 - graphTop);
    drawNightscoutGraph(image, { x: 22, y: graphTop, width: width - 44, height: graphHeight }, nightscout, nowMs, font);
    image.drawText(font, 22, captionY, "2-hour glucose history with basal / carbs / boluses", 130);
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    // The menu lives on the window's long-press menu (see nightscoutMenuItems);
    // double-click at the app root is handled by the yield wrapper.
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}

/** App-specific entries for the window's long-press menu. */
export function nightscoutMenuItems(): MenuItem[] {
  return [
    {
      label: "Refresh",
      onSelect: async (ctx) => {
        ctx.stack.pop();
        await nightscoutBridge.refreshNow();
      },
    },
    {
      label: "Settings",
      onSelect: (ctx) => {
        // Pop the menu first so closing the settings modal lands back on
        // the glucose view, not this menu.
        ctx.stack.pop();
        openSettingsSubMenu(ctx, "Nightscout settings", [
          textSettingMenuItem(nightscoutSiteUrlSetting),
          textSettingMenuItem(nightscoutApiTokenSetting),
        ]);
      },
    },
  ];
}

function isNightscoutPointStale(point: NightscoutState["latest"], nowMs: number): boolean {
  return point !== null && nowMs - point.timestampMs > NIGHTSCOUT_STALE_MS;
}

function drawNightscoutValueStrikeThrough(image: GrayImage, x: number, y: number, width: number): void {
  image.drawLine(x, y, x + width, y, 180);
}
