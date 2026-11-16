/**
 * Session-list and connection-state types shared by the Terminal app's
 * backends (g2mirror-client.ts, apps/terminal/tmux-client.ts). Kept free of
 * platform imports so the tmux client can be unit-tested under node.
 */

export type G2MirrorSession = {
  socket: string;
  pid: number;
  cwdHint: string;
  /** Unix epoch ms of the terminal's last bell, or null if none observed. */
  lastBellAt: number | null;
  /**
   * Unix epoch ms (host clock) of the app's last output, or null if none
   * observed. Fresh to within the wrapper's 2s activity reporting interval
   * while we're connected; compare against other host timestamps, not the
   * phone clock (see the worker's local-receive-time activity tracking).
   */
  lastOutputAt: number | null;
  /** Window title the app last set (xterm OSC 0/2), or null if none observed. */
  title: string | null;
};

export type G2MirrorPhase =
  | "idle"
  | "connecting"
  | "connected" // handshake accepted; can list/attach
  | "attached" // relaying to one session
  | "failed";

export type G2MirrorState = {
  phase: G2MirrorPhase;
  status: string;
  sessions: G2MirrorSession[];
  attachedCommand: string;
  /**
   * server_name from the init success reply: a human-readable name for the
   * machine the server runs on. "" until the handshake succeeds (or when an
   * older server omits the field).
   */
  serverName: string;
  /**
   * False when reconnecting can't help until the user changes something on
   * the host (e.g. tmux missing or too old). Absent means retryable.
   */
  retryable?: boolean;
};

/** A page of archived scrollback lines (see PROTOCOL.md "Scrollback history"). */
export type G2MirrorHistoryReply = {
  /** Absolute index of lines[0]; the page covers [start, start + lines.length). */
  start: number;
  /** Oldest index still retained by the wrapper (older requests return nothing). */
  oldest: number;
  /** Current splice point (next line to be archived). */
  next: number;
  /** Plain text, ANSI-stripped, oldest-to-newest. */
  lines: string[];
};
