import { type GrayImage } from "../../../graphics/image";
import { truncateText } from "../../../graphics/textwrap";
import { getDefaultSmallFont } from "../../../graphics/ui-fonts";
import { lineStep } from "../../../ui/metrics";
import { onWorkerStateChanged, readWorkerState } from "../../../ui/shell/worker-state";
import {
  drawSessionRow,
  isSessionRowActive,
  SESSION_ACTIVITY_STEP_MS,
  TERMINAL_SESSIONS_STATE_KEY,
  type TerminalSessionsSnapshot,
} from "../../terminal/session-list";
import { type GlanceWidget } from "../widget";

const PAD = 8;
const GUTTER_X = PAD;
/** A row fits while its glyph line clears this margin above the bottom edge. */
const BOTTOM_MARGIN = 2;

/**
 * The Terminal app's session list at card size: the same hosts, sessions,
 * activity indicators and open-window numbers as the hub window, painted
 * with the same row painter from the snapshot the Terminal worker publishes.
 * The indicator animates on the hub's cadence while any session is active;
 * each row carries its own activity deadline, so nothing needs the worker
 * once the snapshot is in.
 */
export class TerminalWidget implements GlanceWidget {
  private snapshot: TerminalSessionsSnapshot | undefined = readWorkerState(TERMINAL_SESSIONS_STATE_KEY);
  private unsubscribe: (() => void) | null = null;
  private requestRender: (() => void) | null = null;
  private phase = 0;
  private animationTimer: ReturnType<typeof setInterval> | null = null;

  start(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.snapshot = readWorkerState(TERMINAL_SESSIONS_STATE_KEY);
    this.unsubscribe = onWorkerStateChanged<TerminalSessionsSnapshot>(TERMINAL_SESSIONS_STATE_KEY, (snapshot) => {
      this.snapshot = snapshot;
      this.syncAnimation();
      requestRender();
    });
    this.syncAnimation();
  }

  stop(): void {
    this.requestRender = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.animationTimer !== null) clearInterval(this.animationTimer);
    this.animationTimer = null;
  }

  private anyActive(nowMs = Date.now()): boolean {
    return Boolean(this.snapshot?.hosts.some((host) => host.sessions.some((row) => isSessionRowActive(row, nowMs))));
  }

  /** Run the indicator clock only while something is active; the last tick clears expired ones. */
  private syncAnimation(): void {
    const shouldRun = this.anyActive();
    if (shouldRun && this.animationTimer === null) {
      this.phase = 0;
      this.animationTimer = setInterval(() => {
        this.phase = (this.phase + 1) % 2;
        this.requestRender?.();
        if (!this.anyActive()) this.syncAnimation();
      }, SESSION_ACTIVITY_STEP_MS);
    } else if (!shouldRun && this.animationTimer !== null) {
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }
  }

  paint(image: GrayImage): void {
    const font = getDefaultSmallFont();
    const step = lineStep(font);
    const textWidth = image.width - 2 * PAD;
    const snapshot = this.snapshot;
    const nowMs = Date.now();
    let y = PAD;
    image.drawText(font, PAD, y, "Terminal", 150);
    y += step;

    if (!snapshot) {
      image.drawText(font, PAD, y, "Open the Terminal app to connect", 120);
      return;
    }
    const hosts = snapshot.hosts;
    const sessionCount = hosts.reduce((sum, host) => sum + host.sessions.length, 0);
    if (!hosts.length || !sessionCount) {
      const text = !snapshot.configured
        ? "No connections configured"
        : !hosts.length
          ? snapshot.status
          : "No live sessions";
      image.drawText(font, PAD, y, truncateText(font, text, textWidth), 120);
      return;
    }

    // Rows are placed a line step apart but only need their line height to
    // fit, so the last one may sit right against the bottom margin.
    const fits = (top: number) => top + font.lineHeight <= image.height - BOTTOM_MARGIN;
    const multiHost = hosts.length > 1;
    for (const host of hosts) {
      if (multiHost) {
        if (!fits(y)) return;
        image.drawText(font, PAD, y, truncateText(font, host.name, textWidth), 110);
        y += step;
      }
      for (const row of host.sessions) {
        if (!fits(y)) return;
        drawSessionRow(image, font, {
          x: GUTTER_X,
          y,
          width: image.width - GUTTER_X - PAD,
          label: row.label,
          openGlyph: row.openGlyph,
          active: isSessionRowActive(row, nowMs),
          phase: this.phase,
          value: 200,
        });
        y += step;
      }
    }
  }
}
