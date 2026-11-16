import type {
  G2MirrorHistoryReply,
  G2MirrorPhase,
  G2MirrorSession,
  G2MirrorState,
} from "../../native/terminal-session-types";

/**
 * What the Terminal worker needs from a session backend. G2MirrorClient (a
 * g2mirror server, directly or tunnelled over SSH) and TmuxClient (tmux
 * control mode over SSH) both provide it. The model is g2mirror's: a client
 * starts "connecting", reaches "connected" (it can list and launch sessions,
 * and reports bells/activity/titles for them), and can then attach to one
 * session, view it (snapshot + live output), page its scrollback, and type
 * into it.
 */
export interface TerminalClient {
  state(): G2MirrorState;
  onStateChange(listener: (state: G2MirrorState) => void): () => void;
  /** Raw VT100/xterm bytes to feed the emulator. Snapshot implies reset-first. */
  onTerminalData(listener: (data: Uint8Array, kind: "snapshot" | "output") => void): () => void;
  onSessionAttached(listener: (command: string) => void): () => void;
  onSessionDetached(listener: (reason: string) => void): () => void;
  onBell(listener: (socket: string, lastBellAtMs: number) => void): () => void;
  onActivity(listener: (socket: string, lastOutputAtMs: number) => void): () => void;
  onTitle(listener: (socket: string, title: string) => void): () => void;
  /** Fired after a snapshot's terminal data, with its scrollback splice point. */
  onSnapshot(listener: (historyNext: number, historyOldest: number) => void): () => void;
  onHistoryLines(listener: (reply: G2MirrorHistoryReply) => void): () => void;
  setViewport(cols: number, rows: number): void;
  start(): void;
  stop(): void;
  listSessions(): void;
  launchSession(preset: string): Promise<string>;
  connectSession(socket: string): void;
  disconnectSession(): void;
  view(): void;
  unview(): void;
  requestHistory(before: number, limit?: number): void;
  sendInput(text: string): void;
  submitInput(text: string): void;
}

export type { G2MirrorHistoryReply, G2MirrorPhase, G2MirrorSession, G2MirrorState };
