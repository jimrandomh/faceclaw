import { toUint8Array } from "../util/array-util";

declare const com: any;
declare const android: any;
declare const java: any;

/**
 * Client for the g2mirror terminal-mirroring protocol (see
 * ../experiments/g2mirror/PROTOCOL.md). One instance per Terminal app
 * session; talks JSON over a websocket to g2mirror-server, which relays to
 * one wrapped CLI app at a time.
 */

const PROTOCOL_VERSION = 1;
const SESSION_LIST_REFRESH_MS = 3_000;
const LAUNCH_REPLY_TIMEOUT_MS = 10_000;
// Wrapper-side pause between submitted text and its trailing "\r". Apps that
// infer pasting from bytes arriving in one read (e.g. Claude Code) would
// otherwise treat the "\r" as a pasted newline instead of the Enter key.
const SUBMIT_DELAY_MS = 150;

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

export type G2MirrorClientOptions = {
  /** TLS (g2mirrors:// → wss) vs plain (g2mirror:// → ws). */
  secure: boolean;
  host: string;
  port: number;
  authToken: string;
  deviceName: string;
  cols: number;
  rows: number;
};

type TerminalDataKind = "snapshot" | "output";

export class G2MirrorClient {
  private ws: any = null;
  private listenerProxy: any = null;
  private phase: G2MirrorPhase = "idle";
  private status = "Not connected.";
  private sessions: G2MirrorSession[] = [];
  private attachedCommand = "";
  private serverName = "";
  // Scrollback archive extent: `historyNext` is the splice point (index of the
  // next line to be archived), `historyOldest` the oldest retained index.
  private historyNext = 0;
  private historyOldest = 0;
  private listRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly stateListeners = new Set<(state: G2MirrorState) => void>();
  private readonly terminalDataListeners = new Set<(data: Uint8Array, kind: TerminalDataKind) => void>();
  private readonly snapshotListeners = new Set<(historyNext: number, historyOldest: number) => void>();
  private readonly historyLinesListeners = new Set<(reply: G2MirrorHistoryReply) => void>();
  private readonly sessionAttachedListeners = new Set<(command: string) => void>();
  private readonly sessionDetachedListeners = new Set<(reason: string) => void>();
  private readonly bellListeners = new Set<(socket: string, lastBellAtMs: number) => void>();
  private readonly activityListeners = new Set<(socket: string, lastOutputAtMs: number) => void>();
  private readonly titleListeners = new Set<(socket: string, title: string) => void>();
  // Launch requests awaiting their reply, oldest first. The server answers
  // each `launch` with either `launched` or an `error` whose message starts
  // with "launch failed", so replies are matched to requests in order.
  private readonly pendingLaunches: Array<{
    resolve: (socket: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(private readonly options: G2MirrorClientOptions) {}

  state(): G2MirrorState {
    return {
      phase: this.phase,
      status: this.status,
      sessions: this.sessions.slice(),
      attachedCommand: this.attachedCommand,
      serverName: this.serverName,
    };
  }

  onStateChange(listener: (state: G2MirrorState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Raw VT100/xterm bytes to feed the emulator. Snapshot implies reset-first. */
  onTerminalData(listener: (data: Uint8Array, kind: TerminalDataKind) => void): () => void {
    this.terminalDataListeners.add(listener);
    return () => this.terminalDataListeners.delete(listener);
  }

  onSessionAttached(listener: (command: string) => void): () => void {
    this.sessionAttachedListeners.add(listener);
    return () => this.sessionAttachedListeners.delete(listener);
  }

  onSessionDetached(listener: (reason: string) => void): () => void {
    this.sessionDetachedListeners.add(listener);
    return () => this.sessionDetachedListeners.delete(listener);
  }

  /** Unsolicited bell notification for any monitored terminal (rate-limited server-side). */
  onBell(listener: (socket: string, lastBellAtMs: number) => void): () => void {
    this.bellListeners.add(listener);
    return () => this.bellListeners.delete(listener);
  }

  /**
   * Unsolicited output-activity notification for any monitored terminal
   * (rate-limited by the wrapper to one per 2s per terminal, leading edge
   * only — notifications stop as soon as the output does).
   */
  onActivity(listener: (socket: string, lastOutputAtMs: number) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  /** Unsolicited title change for any monitored terminal. */
  onTitle(listener: (socket: string, title: string) => void): () => void {
    this.titleListeners.add(listener);
    return () => this.titleListeners.delete(listener);
  }

  start(): void {
    if (this.ws) return;
    this.stopped = false;
    const url = `${this.options.secure ? "wss" : "ws"}://${this.options.host}:${this.options.port}`;
    this.setState("connecting", `Connecting to ${this.options.host}:${this.options.port}...`);
    this.listenerProxy = new com.faceclaw.app.FaceclawWebSocketListener({
      onOpen: () => {
        if (this.stopped) return;
        this.setState("connecting", "Authenticating...");
        this.send({
          type: "init",
          version: PROTOCOL_VERSION,
          auth_token: this.options.authToken,
          device: this.options.deviceName,
          width: this.options.cols,
          height: this.options.rows,
        });
      },
      onTextMessage: (message: string) => {
        if (this.stopped) return;
        this.handleMessage(String(message));
      },
      onClosed: (code: number, reason: string) => {
        if (this.stopped) return;
        this.handleConnectionLost(`Connection closed (${Number(code)}${reason ? `: ${String(reason)}` : ""}).`);
      },
      onFailure: (message: string) => {
        if (this.stopped) return;
        this.handleConnectionLost(`Connection failed: ${shortenError(String(message))}`);
      },
    });
    try {
      this.ws = new com.faceclaw.app.FaceclawWebSocket(url, this.listenerProxy, null, null);
    } catch (error) {
      this.ws = null;
      this.handleConnectionLost(`Connection failed: ${shortenError(String((error as Error)?.message ?? error))}`);
    }
  }

  stop(): void {
    this.stopped = true;
    this.rejectAllPendingLaunches("client stopped");
    this.clearListRefreshTimer();
    if (this.ws) {
      // Best effort: let the wrapped app resize back before we go away.
      if (this.phase === "attached") {
        this.send({ type: "unview" });
        this.send({ type: "disconnect" });
      }
      try {
        this.ws.close(1000, "bye");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.listenerProxy = null;
    this.setState("idle", "Not connected.");
  }

  listSessions(): void {
    if (this.phase === "connected" || this.phase === "attached") {
      this.send({ type: "list" });
    }
  }

  /**
   * Start a new detached session from a named server-side launch preset (the
   * wire can only pick presets by name, never supply a command line; the
   * token needs a launch grant covering the preset). Resolves with the new
   * session's socket, which can then be attached like any other session.
   */
  launchSession(preset: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.phase !== "connected" && this.phase !== "attached") {
        reject(new Error("Not connected to the g2mirror server."));
        return;
      }
      const pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.pendingLaunches.indexOf(pending);
          if (index >= 0) this.pendingLaunches.splice(index, 1);
          reject(new Error(`Launch of "${preset}" timed out.`));
        }, LAUNCH_REPLY_TIMEOUT_MS),
      };
      this.pendingLaunches.push(pending);
      this.send({ type: "launch", command: preset });
    });
  }

  connectSession(socket: string): void {
    if (this.phase !== "connected") return;
    this.setState(this.phase, "Attaching to session...");
    this.send({ type: "connect", socket });
  }

  disconnectSession(): void {
    if (this.phase !== "attached") return;
    this.send({ type: "unview" });
    this.send({ type: "disconnect" });
  }

  view(): void {
    if (this.phase !== "attached") return;
    this.send({ type: "view" });
  }

  /**
   * A snapshot arrived, carrying its scrollback splice point (`history_next`)
   * and the oldest retained index. Fired after the snapshot's terminal data.
   */
  onSnapshot(listener: (historyNext: number, historyOldest: number) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  /** A page of archived scrollback (reply to requestHistory). */
  onHistoryLines(listener: (reply: G2MirrorHistoryReply) => void): () => void {
    this.historyLinesListeners.add(listener);
    return () => this.historyLinesListeners.delete(listener);
  }

  /** Request archived lines ending just before `before`, paging backwards. */
  requestHistory(before: number, limit = 200): void {
    if (this.phase !== "attached") return;
    this.send({ type: "history", before, limit });
  }

  /**
   * Write bytes to the attached app's terminal, as a terminal emulator would
   * for keystrokes. `text` is sent as UTF-8; include a trailing "\r" to submit
   * (the Enter key). No-op unless a session is attached.
   */
  sendInput(text: string): void {
    if (this.phase !== "attached" || !text) return;
    this.send({ type: "input", data: encodeBase64Utf8(text) });
  }

  /**
   * Send `text` followed by Enter ("\r") as one input message, with a
   * wrapper-side pause before the "\r" (the protocol's `delays` field) so the
   * app reads it as a separate Enter keypress rather than the tail of a
   * paste. Older wrappers ignore `delays`, so this degrades to sendInput.
   */
  submitInput(text: string): void {
    if (this.phase !== "attached") return;
    const textByteLength = new java.lang.String(text).getBytes("UTF-8").length;
    this.send({
      type: "input",
      data: encodeBase64Utf8(`${text}\r`),
      delays: [{ at: textByteLength, ms: SUBMIT_DELAY_MS }],
    });
  }

  unview(): void {
    if (this.phase !== "attached") return;
    this.send({ type: "unview" });
  }

  private handleMessage(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message.type !== "string") return;

    switch (message.type) {
      case "init":
        if (typeof message.server_name === "string" && message.server_name) {
          this.serverName = message.server_name;
        }
        this.setState("connected", "Connected.");
        this.listSessions();
        this.ensureListRefreshTimer();
        return;
      case "error": {
        const errorText = String(message.message ?? "unknown error");
        if (errorText.startsWith("launch failed") && this.pendingLaunches.length) {
          this.settlePendingLaunch(null, errorText);
        }
        if (this.phase === "connecting") {
          // Handshake rejection; the server closes the socket after this.
          this.setState("failed", `Rejected: ${errorText}`);
        } else {
          this.setState(this.phase, `Server error: ${errorText}`);
        }
        return;
      }
      case "sessions": {
        const raw = Array.isArray(message.sessions) ? message.sessions : [];
        this.sessions = raw
          .map((item: any): G2MirrorSession => ({
            socket: String(item?.socket ?? ""),
            pid: Number(item?.pid) || 0,
            cwdHint: String(item?.cwd_hint ?? ""),
            lastBellAt: typeof item?.last_bell_at === "number" ? item.last_bell_at : null,
            lastOutputAt: typeof item?.last_output_at === "number" ? item.last_output_at : null,
            title: typeof item?.title === "string" ? item.title : null,
          }))
          .filter((session: G2MirrorSession) => session.socket.length > 0);
        this.emitState();
        return;
      }
      case "bell": {
        const socket = String(message.socket ?? "");
        const lastBellAt = Number(message.last_bell_at) || Date.now();
        if (!socket) return;
        const session = this.sessions.find((s) => s.socket === socket);
        if (session) session.lastBellAt = lastBellAt;
        for (const listener of Array.from(this.bellListeners)) {
          listener(socket, lastBellAt);
        }
        return;
      }
      case "activity": {
        const socket = String(message.socket ?? "");
        const lastOutputAt = Number(message.last_output_at) || 0;
        if (!socket || !lastOutputAt) return;
        const session = this.sessions.find((s) => s.socket === socket);
        if (session) session.lastOutputAt = lastOutputAt;
        // No emitState: activity is frequent while an app is busy, and the
        // terminal worker drives its own hub animation off the listener.
        for (const listener of Array.from(this.activityListeners)) {
          listener(socket, lastOutputAt);
        }
        return;
      }
      case "title": {
        const socket = String(message.socket ?? "");
        const title = String(message.title ?? "");
        if (!socket) return;
        const session = this.sessions.find((s) => s.socket === socket);
        if (session) session.title = title;
        for (const listener of Array.from(this.titleListeners)) {
          listener(socket, title);
        }
        this.emitState();
        return;
      }
      case "launched": {
        const socket = String(message.socket ?? "");
        this.settlePendingLaunch(socket, `launch reply carried no socket`);
        this.listSessions();
        return;
      }
      case "connect": {
        // Session accepted us (relayed from the wrapper).
        this.clearListRefreshTimer();
        this.attachedCommand = String(message.command ?? "");
        const history = message.history;
        if (history && typeof history.next === "number") {
          this.historyNext = Number(history.next) || 0;
          this.historyOldest = Number(history.oldest) || 0;
        }
        this.setState("attached", `Attached: ${this.attachedCommand || "session"}`);
        for (const listener of Array.from(this.sessionAttachedListeners)) {
          listener(this.attachedCommand);
        }
        return;
      }
      case "snapshot": {
        const data = decodeBase64(String(message.data ?? ""));
        if (typeof message.history_next === "number") {
          this.historyNext = Number(message.history_next) || 0;
        }
        for (const listener of Array.from(this.terminalDataListeners)) {
          listener(data, "snapshot");
        }
        for (const listener of Array.from(this.snapshotListeners)) {
          listener(this.historyNext, this.historyOldest);
        }
        return;
      }
      case "output": {
        const data = decodeBase64(String(message.data ?? ""));
        for (const listener of Array.from(this.terminalDataListeners)) {
          listener(data, "output");
        }
        return;
      }
      case "history_lines": {
        const start = Number(message.start) || 0;
        const oldest = Number(message.oldest) || 0;
        const next = Number(message.next) || 0;
        const rawLines = Array.isArray(message.lines) ? message.lines : [];
        const lines = rawLines.map((line: any) => stripAnsi(decodeBase64Utf8(String(line?.data ?? ""))));
        this.historyOldest = oldest;
        for (const listener of Array.from(this.historyLinesListeners)) {
          listener({ start, oldest, next, lines });
        }
        return;
      }
      case "exit": {
        const status = message.status === null || message.status === undefined ? "signal" : String(message.status);
        this.setState(this.phase, `Session exited (status ${status}).`);
        return;
      }
      case "disconnected": {
        const reason = String(message.reason ?? "unknown");
        this.attachedCommand = "";
        if (this.phase === "attached") {
          this.setState("connected", `Detached (${reason}).`);
          this.ensureListRefreshTimer();
          this.listSessions();
          for (const listener of Array.from(this.sessionDetachedListeners)) {
            listener(reason);
          }
        }
        return;
      }
      default:
        // Unknown message types are expected; ignore for forward compatibility.
        return;
    }
  }

  /** Settle the oldest pending launch: resolve with `socket` if non-empty, else reject. */
  private settlePendingLaunch(socket: string | null, errorText: string): void {
    const pending = this.pendingLaunches.shift();
    if (!pending) return;
    clearTimeout(pending.timer);
    if (socket) {
      pending.resolve(socket);
    } else {
      pending.reject(new Error(errorText));
    }
  }

  private rejectAllPendingLaunches(reason: string): void {
    while (this.pendingLaunches.length) {
      this.settlePendingLaunch(null, reason);
    }
  }

  private handleConnectionLost(statusText: string): void {
    this.rejectAllPendingLaunches("connection lost");
    this.clearListRefreshTimer();
    this.ws = null;
    this.listenerProxy = null;
    const wasAttached = this.phase === "attached";
    this.attachedCommand = "";
    this.setState("failed", statusText);
    if (wasAttached) {
      for (const listener of Array.from(this.sessionDetachedListeners)) {
        listener("connection lost");
      }
    }
  }

  private ensureListRefreshTimer(): void {
    if (this.listRefreshTimer) return;
    this.listRefreshTimer = setInterval(() => {
      if (this.phase === "connected") {
        this.listSessions();
      }
    }, SESSION_LIST_REFRESH_MS);
  }

  private clearListRefreshTimer(): void {
    if (this.listRefreshTimer) {
      clearInterval(this.listRefreshTimer);
      this.listRefreshTimer = null;
    }
  }

  private send(message: object): void {
    if (!this.ws) return;
    try {
      this.ws.sendText(JSON.stringify(message));
    } catch (error) {
      console.warn("g2mirror send failed", error);
    }
  }

  private setState(phase: G2MirrorPhase, status: string): void {
    this.phase = phase;
    this.status = status;
    this.emitState();
  }

  private emitState(): void {
    const state = this.state();
    for (const listener of Array.from(this.stateListeners)) {
      listener(state);
    }
  }
}

function decodeBase64(data: string): Uint8Array {
  if (!data) return new Uint8Array(0);
  return toUint8Array(android.util.Base64.decode(data, android.util.Base64.DEFAULT));
}

function decodeBase64Utf8(data: string): string {
  if (!data) return "";
  const bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT);
  return String(new java.lang.String(bytes, "UTF-8"));
}

/** Strip escape sequences (SGR colors, other CSI) so archived lines render as plain text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f]/g, "");
}

function encodeBase64Utf8(text: string): string {
  const bytes = new java.lang.String(text).getBytes("UTF-8");
  return String(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
}

function shortenError(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 117)}...`;
}
