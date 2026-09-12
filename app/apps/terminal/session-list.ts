/**
 * The terminal session list as it is drawn in two places: the Terminal app's
 * hub window (in the worker) and the Glanceboard's Terminal widget (on the
 * main thread). The worker publishes a snapshot of the list through the
 * host's worker-state channel; both painters use drawSessionRow so a row
 * looks the same in each.
 *
 * No NativeScript imports: this module is bundled into the worker as well.
 */
import { type GrayImage, type UiFont } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";

/** Worker-state key the Terminal worker publishes its snapshot under. */
export const TERMINAL_SESSIONS_STATE_KEY = "terminal:sessions";

/** Alternation period of the activity indicator, shared by hub rows, the widget and sidebar cursors. */
export const SESSION_ACTIVITY_STEP_MS = 800;

export type TerminalSessionRow = {
  /** Connection-scoped identity (connection id + socket). */
  key: string;
  label: string;
  /** Local-clock time (Date.now() domain) until which the session counts as active; 0 = idle. */
  activeUntilMs: number;
  /** Sidebar glyph ("1", "2", ...) of the view window showing this session, or null when none is open. */
  openGlyph: string | null;
};

export type TerminalHostGroup = {
  /** Host name, shown as a heading when more than one host is connected. */
  name: string;
  sessions: TerminalSessionRow[];
};

export type TerminalSessionsSnapshot = {
  /** Connected hosts, each with its live sessions most-recently-updated first. */
  hosts: TerminalHostGroup[];
  /** The hub's status line ("Connecting...", "No connections configured.", ...). */
  status: string;
  /** Whether any g2mirror connection is configured at all. */
  configured: boolean;
};

/** Whether a row's activity indicator should show right now. */
export function isSessionRowActive(row: TerminalSessionRow, nowMs = Date.now()): boolean {
  return row.activeUntilMs > nowMs;
}

/** Width of the window-number column (one glyph plus breathing room). */
export function sessionGlyphColumnWidth(font: UiFont): number {
  return font.measureText("W") + 6;
}

/** Left edge of the label in a row whose activity gutter starts at `x`. */
export function sessionLabelX(font: UiFont, x: number): number {
  return x + SESSION_INDICATOR_SIZE + 4 + sessionGlyphColumnWidth(font);
}

const SESSION_INDICATOR_SIZE = 6;

/**
 * One session row: the activity indicator in the gutter at `x` (a small
 * square, filled on even animation phases and outlined on odd ones, drawn as
 * shapes rather than a font glyph so both states read in every UI font),
 * then the open view window's glyph in its own column, then the label,
 * truncated (never wrapped) to fit `width`.
 */
export function drawSessionRow(
  image: GrayImage,
  font: UiFont,
  options: {
    x: number;
    /** Top of the text line. */
    y: number;
    /** Horizontal room from `x`, label included. */
    width: number;
    label: string;
    openGlyph: string | null;
    active: boolean;
    /** Animation phase (0 = filled indicator). */
    phase: number;
    /** Text brightness for the label (the glyph draws a little dimmer). */
    value: number;
  },
): void {
  const { x, y, width, label, openGlyph, active, phase, value } = options;
  if (active) {
    const iy = y + Math.max(0, ((font.lineHeight - SESSION_INDICATOR_SIZE) / 2) | 0);
    if (phase % 2 === 0) {
      image.fillRect(x, iy, SESSION_INDICATOR_SIZE, SESSION_INDICATOR_SIZE, value);
    } else {
      image.drawRect(x, iy, SESSION_INDICATOR_SIZE, SESSION_INDICATOR_SIZE, value);
    }
  }
  if (openGlyph) {
    image.drawText(font, x + SESSION_INDICATOR_SIZE + 4, y, openGlyph, Math.max(0, value - 60));
  }
  const labelX = sessionLabelX(font, x);
  image.drawText(font, labelX, y, truncateText(font, label, Math.max(0, x + width - labelX)), value);
}
