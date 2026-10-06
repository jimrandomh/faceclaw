import { type GrayImage, type UiFont } from "../../../graphics/image";
import { truncateText } from "../../../graphics/textwrap";
import { lineStep } from "../../../ui/metrics";
import { onWorkerStateChanged, readWorkerState } from "../../../ui/shell/worker-state";
import { loadEnvironments } from "../../t3code/t3-environments";
import { glanceSummary, T3_GLANCE_STATE_KEY, type T3GlanceRow, type T3GlanceSnapshot } from "../../t3code/t3-glance";
import { formatAge, threadMarker } from "../../t3code/t3-model";
import { glanceFont } from "../glance-font";
import { type GlanceWidget } from "../widget";

const PAD = 8;
/** A row fits while its glyph line clears this margin above the bottom edge. */
const BOTTOM_MARGIN = 2;
const MINUTE_MS = 60_000;

/**
 * T3 Code's agent threads at a glance: how many need you and how many are
 * working, then the threads themselves in the app's order (needs-you, then
 * working, then recent) with the app's status marks. Approvals and questions
 * say so at the right edge; other rows show how long ago they were active.
 * Painted from the snapshot the T3 worker publishes; the app's boot hook
 * keeps that worker connected while this widget is on an enabled board.
 */
export class T3CodeWidget implements GlanceWidget {
  private snapshot = readWorkerState(T3_GLANCE_STATE_KEY) as T3GlanceSnapshot | undefined;
  private unsubscribe: (() => void) | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;

  start(requestRender: () => void): void {
    this.stop();
    this.snapshot = readWorkerState(T3_GLANCE_STATE_KEY) as T3GlanceSnapshot | undefined;
    this.unsubscribe = onWorkerStateChanged(T3_GLANCE_STATE_KEY, (snapshot) => {
      this.snapshot = snapshot as T3GlanceSnapshot | undefined;
      requestRender();
    });
    // Keeps the ages honest while the board stays up.
    this.tick = setInterval(requestRender, MINUTE_MS);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.tick !== null) clearInterval(this.tick);
    this.tick = null;
  }

  paint(image: GrayImage): void {
    const font = glanceFont.small();
    const step = lineStep(font);
    const textWidth = image.width - 2 * PAD;
    const snapshot = this.snapshot;
    let y = PAD;

    const title = "T3 Code";
    image.drawText(font, PAD, y, title, 150);
    const summary = snapshot ? glanceSummary(snapshot) : "";
    if (summary) {
      const text = truncateText(font, summary, textWidth - font.measureText(title) - 12);
      image.drawText(font, image.width - PAD - font.measureText(text), y, text, snapshot!.needsYou ? 230 : 140);
    }
    y += step;

    const message = !snapshot
      ? noWorkerMessage()
      : !snapshot.configured
        ? "Pair a computer in the T3 Code app"
        : snapshot.status || (!snapshot.rows.length ? "No active threads" : "");
    if (message) {
      image.drawText(font, PAD, y, truncateText(font, message, textWidth), 120);
      return;
    }

    const rows = snapshot!.rows;
    // Rows are placed a line step apart but only need their line height to fit.
    const capacity = Math.max(0, Math.floor((image.height - BOTTOM_MARGIN - y - font.lineHeight) / step) + 1);
    const hidden = rows.length + snapshot!.more - capacity;
    const shown = hidden > 0 ? rows.slice(0, Math.max(0, capacity - 1)) : rows;
    const nowMs = Date.now();
    const markerWidth = font.measureText("W") + 7;
    for (const row of shown) {
      paintRow(image, font, row, PAD, y, textWidth, markerWidth, nowMs);
      y += step;
    }
    if (hidden > 0) {
      image.drawText(font, PAD + markerWidth, y, `+${rows.length + snapshot!.more - shown.length} more`, 110);
    }
  }
}

/** Before the T3 worker publishes anything (or after it stopped for lack of anything to connect to). */
function noWorkerMessage(): string {
  const environments = loadEnvironments();
  if (!environments.length) return "Pair a computer in the T3 Code app";
  if (!environments.some((environment) => environment.enabled)) return "Disconnected in the T3 Code app";
  return "Connecting…";
}

function rowRightText(row: T3GlanceRow, nowMs: number): string {
  if (row.status === "approval") return row.requestKind === "file-change" ? "approve edit" : "approve";
  if (row.status === "input") return "question";
  return formatAge(row.activityMs, nowMs);
}

function paintRow(
  image: GrayImage,
  font: UiFont,
  row: T3GlanceRow,
  x: number,
  y: number,
  width: number,
  markerWidth: number,
  nowMs: number,
): void {
  const { marker, value: markerValue } = threadMarker(row.status, { unread: row.unread });
  if (marker) image.drawText(font, x, y, marker, markerValue);
  const needsYou = row.status === "approval" || row.status === "input";
  const right = rowRightText(row, nowMs);
  const rightWidth = right ? font.measureText(right) + 8 : 0;
  if (right) image.drawText(font, x + width - font.measureText(right), y, right, needsYou ? 230 : 110);
  const value = needsYou ? 255 : row.status === "working" || row.unread ? 215 : 165;
  image.drawText(font, x + markerWidth, y, truncateText(font, row.title, Math.max(10, width - markerWidth - rightWidth)), value);
}
