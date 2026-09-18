import { type GrayImage, type UiFont } from "../graphics/image";
import { truncateText } from "../graphics/textwrap";
import { formatDuration, type DailySummary, type MetricSummary } from "./health-derive";

export type HealthCardData =
  | { kind: "live"; summary: DailySummary; hasSteps: boolean; hasCalories: boolean }
  | { kind: "fixture" | "empty" | "error" };

const PAD = 8;

/** Three columns keep all six metrics legible in a 288 x 144 board slot. */
export function drawHealthCard(image: GrayImage, data: HealthCardData, small: UiFont, medium: UiFont): void {
  image.drawText(small, PAD, PAD, "Health", 180);
  const today = "Today";
  image.drawText(small, image.width - PAD - small.measureText(today), PAD, today, 130);

  const top = PAD + small.lineHeight + 6;
  if (data.kind !== "live") {
    const title = data.kind === "fixture" ? "Sample data"
      : data.kind === "error" ? "Health unavailable" : "No health data today";
    const subtitle = data.kind === "fixture" ? "Open Health for details"
      : data.kind === "error" ? "Open Health to retry" : "Open Health to sync";
    const font = medium.measureText(title) <= image.width - PAD * 2 ? medium : small;
    const y = Math.round(top + (image.height - PAD - top - font.lineHeight - small.lineHeight - 6) / 2);
    const text = truncateText(font, title, image.width - PAD * 2);
    image.drawText(font, Math.round((image.width - font.measureText(text)) / 2), y, text, 240);
    const hint = truncateText(small, subtitle, image.width - PAD * 2);
    image.drawText(small, Math.round((image.width - small.measureText(hint)) / 2), y + font.lineHeight + 6, hint, 150);
    return;
  }

  const average = (metric: MetricSummary, units: string): string =>
    metric.hasData ? `${Math.round(metric.avg)}${units}` : "--";
  const { summary } = data;
  const cells: [string, string][] = [
    ["HR avg", average(summary.heartRate, " bpm")],
    ["HRV avg", average(summary.hrv, " ms")],
    ["SpO2 avg", average(summary.spo2, "%")],
    ["Steps", data.hasSteps ? String(summary.steps) : "--"],
    ["Cal (kcal)", data.hasCalories ? String(summary.calories) : "--"],
    ["Sleep", summary.sleep ? formatDuration(summary.sleep.totalSec) : "--"],
  ];
  const columnWidth = (image.width - PAD * 2) / 3;
  const rowHeight = (image.height - PAD - top) / 2;
  cells.forEach(([label, value], index) => {
    const left = PAD + Math.floor((index % 3) * columnWidth);
    const y = top + Math.floor(Math.floor(index / 3) * rowHeight);
    const width = Math.floor(columnWidth) - 6;
    const font = medium.measureText(value) <= width
      && small.lineHeight + 2 + medium.lineHeight <= rowHeight - 2 ? medium : small;
    const fittedLabel = label === "Cal (kcal)" && small.measureText(label) > width ? "kcal" : label;
    image.drawText(small, left, y, truncateText(small, fittedLabel, width), 140);
    image.drawText(font, left, y + small.lineHeight + 2, truncateText(font, value, width), 235);
  });
}
