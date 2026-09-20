import type { Terminal as XtermTerminal } from "@xterm/headless";

// xterm-headless expects a few browser globals (navigator for platform
// sniffing, window for timer/scheduling lookups) that the NativeScript
// runtime doesn't define. Provide minimal stand-ins before the library is
// evaluated (hence require, not a hoisted import).
const runtimeGlobal = globalThis as any;
if (typeof runtimeGlobal.navigator === "undefined") {
  runtimeGlobal.navigator = {
    userAgent: "NativeScript",
    platform: "Android",
    language: "en",
    languages: ["en"],
  };
}
if (typeof runtimeGlobal.window === "undefined") {
  runtimeGlobal.window = runtimeGlobal;
}
if (typeof runtimeGlobal.self === "undefined") {
  runtimeGlobal.self = runtimeGlobal;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");

/**
 * Headless terminal emulator for g2mirror streams: feed it the raw
 * VT100/xterm bytes from snapshot/output messages and read back the visible
 * text grid. Formatting (color/bold/inverse) is deliberately dropped for
 * now — we only mirror the text.
 */
export class TerminalEmulator {
  private readonly term: XtermTerminal;

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.term = new Terminal({
      cols,
      rows,
      // Retain witnessed lines that scroll off the top; the archive covers
      // everything before this. Matches the wrapper's default history cap.
      scrollback: 10000,
      allowProposedApi: true,
    });
  }

  /**
   * Apply terminal bytes. onProcessed fires once the emulator has actually
   * parsed them (xterm buffers writes internally), so schedule repaints there.
   */
  write(data: Uint8Array, onProcessed: () => void): void {
    this.term.write(data, onProcessed);
  }

  dispose(): void {
    this.term.dispose();
  }

  /** Full reset; snapshots are defined as repainting from a cleared screen. */
  reset(): void {
    this.term.reset();
  }

  /** Total lines held (witnessed scrollback + the live screen). */
  bufferLength(): number {
    return this.term.buffer.active.length;
  }

  /** Text of buffer line `index` (0 = oldest retained), trailing space trimmed. */
  lineAt(index: number): string {
    const line = this.term.buffer.active.getLine(index);
    return line ? line.translateToString(true) : "";
  }

  /** Cursor row as an absolute buffer index (baseY + cursorY). */
  cursorRow(): number {
    const buffer = this.term.buffer.active;
    return buffer.baseY + buffer.cursorY;
  }

  cursorCol(): number {
    return this.term.buffer.active.cursorX;
  }
}
