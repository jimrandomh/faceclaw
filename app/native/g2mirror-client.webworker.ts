/**
 * The browser demo's Terminal has no computer to mirror, so this is the g2mirror
 * client's surface over a simulated host: the Terminal app, its emulator and its
 * hub are the real thing, and only the bytes are scripted (app/web/demo-data/terminal.ts).
 */
import { DEMO_TERMINAL_SERVER_NAME, demoTerminalSessions, launchDemoTerminalSession, type DemoTerminalSession } from "../web/demo-data/terminal";

export type G2MirrorSession = {
  socket: string;
  pid: number;
  cwdHint: string;
  lastBellAt: number | null;
  lastOutputAt: number | null;
  title: string | null;
};
export type G2MirrorPhase = "idle" | "connecting" | "connected" | "attached" | "failed";
export type G2MirrorState = { phase: G2MirrorPhase; status: string; sessions: G2MirrorSession[]; attachedCommand: string; serverName: string };
export type G2MirrorHistoryReply = { start: number; oldest: number; next: number; lines: string[] };
export type G2MirrorClientOptions = { secure: boolean; host: string; port: number; authToken: string; deviceName: string; cols: number; rows: number };
type TerminalDataKind = "snapshot" | "output";

const encoder = new TextEncoder();

export class G2MirrorClient {
  private phase: G2MirrorPhase = "idle";
  private status = "Not connected.";
  private attachedCommand = "";
  private attached: DemoTerminalSession | null = null;
  private viewing = false;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly stateListeners = new Set<(state: G2MirrorState) => void>();
  private readonly dataListeners = new Set<(data: Uint8Array, kind: TerminalDataKind) => void>();
  private readonly snapshotListeners = new Set<(historyNext: number, historyOldest: number) => void>();
  private readonly attachedListeners = new Set<(command: string) => void>();
  private readonly detachedListeners = new Set<(reason: string) => void>();
  private readonly bellListeners = new Set<(socket: string, lastBellAtMs: number) => void>();
  private readonly activityListeners = new Set<(socket: string, lastOutputAtMs: number) => void>();
  private readonly titleListeners = new Set<(socket: string, title: string) => void>();

  constructor(private readonly options: G2MirrorClientOptions) {}

  state(): G2MirrorState {
    return {
      phase: this.phase,
      status: this.status,
      sessions: this.phase === "connected" || this.phase === "attached" ? demoTerminalSessions().map((session) => session.describe()) : [],
      attachedCommand: this.attachedCommand,
      serverName: this.phase === "connected" || this.phase === "attached" ? DEMO_TERMINAL_SERVER_NAME : "",
    };
  }

  private setState(phase: G2MirrorPhase, status: string): void {
    this.phase = phase;
    this.status = status;
    const state = this.state();
    for (const listener of [...this.stateListeners]) listener(state);
  }

  onStateChange(listener: (state: G2MirrorState) => void): () => void { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }
  onTerminalData(listener: (data: Uint8Array, kind: TerminalDataKind) => void): () => void { this.dataListeners.add(listener); return () => this.dataListeners.delete(listener); }
  onSessionAttached(listener: (command: string) => void): () => void { this.attachedListeners.add(listener); return () => this.attachedListeners.delete(listener); }
  onSessionDetached(listener: (reason: string) => void): () => void { this.detachedListeners.add(listener); return () => this.detachedListeners.delete(listener); }
  onBell(listener: (socket: string, lastBellAtMs: number) => void): () => void { this.bellListeners.add(listener); return () => this.bellListeners.delete(listener); }
  onActivity(listener: (socket: string, lastOutputAtMs: number) => void): () => void { this.activityListeners.add(listener); return () => this.activityListeners.delete(listener); }
  onTitle(listener: (socket: string, title: string) => void): () => void { this.titleListeners.add(listener); return () => this.titleListeners.delete(listener); }
  onSnapshot(listener: (historyNext: number, historyOldest: number) => void): () => void { this.snapshotListeners.add(listener); return () => this.snapshotListeners.delete(listener); }
  onHistoryLines(_listener: (reply: G2MirrorHistoryReply) => void): () => void { return () => {}; }
  setViewport(cols: number, rows: number): void { this.options.cols = cols; this.options.rows = rows; }

  start(): void {
    if (this.phase !== "idle" && this.phase !== "failed") return;
    this.setState("connecting", "Connecting...");
    setTimeout(() => {
      if (this.phase !== "connecting") return;
      for (const session of demoTerminalSessions()) this.watch(session);
      this.setState("connected", "Connected.");
    }, 120);
  }

  /** Hub-level news from one session: what the host relays for every session it serves. */
  private watch(session: DemoTerminalSession): void {
    this.unsubscribers.push(session.subscribe({
      onBell: (at) => { for (const listener of [...this.bellListeners]) listener(session.socket, at); },
      onOutput: (text, at) => {
        for (const listener of [...this.activityListeners]) listener(session.socket, at);
        if (this.attached === session && this.viewing) {
          const data = encoder.encode(text);
          for (const listener of [...this.dataListeners]) listener(data, "output");
        }
      },
      onTitle: (title) => { for (const listener of [...this.titleListeners]) listener(session.socket, title); },
    }));
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.attached = null;
    this.viewing = false;
    this.attachedCommand = "";
    this.setState("idle", "Not connected.");
  }

  listSessions(): void {
    if (this.phase === "connected" || this.phase === "attached") this.setState(this.phase, this.status);
  }

  async launchSession(preset: string): Promise<string> {
    const session = launchDemoTerminalSession(preset);
    this.watch(session);
    this.listSessions();
    return session.socket;
  }

  connectSession(socket: string): void {
    if (this.phase !== "connected") return;
    const session = demoTerminalSessions().find((candidate) => candidate.socket === socket);
    if (!session) {
      for (const listener of [...this.detachedListeners]) listener("session ended");
      return;
    }
    this.attached = session;
    this.attachedCommand = session.command;
    setTimeout(() => {
      if (this.attached !== session) return;
      this.setState("attached", `Attached: ${session.command}`);
      for (const listener of [...this.attachedListeners]) listener(session.command);
    }, 60);
  }

  disconnectSession(): void {
    if (this.phase !== "attached") return;
    this.attached = null;
    this.viewing = false;
    this.setState("connected", "Connected.");
  }

  view(): void {
    if (this.phase !== "attached" || !this.attached) return;
    this.viewing = true;
    const data = encoder.encode(this.attached.screenText());
    for (const listener of [...this.dataListeners]) listener(data, "snapshot");
    for (const listener of [...this.snapshotListeners]) listener(0, 0);
  }

  unview(): void { this.viewing = false; }
  requestHistory(_before: number, _limit = 200): void {}
  sendInput(text: string): void { if (this.phase === "attached" && text) this.attached?.input(text); }
  submitInput(text: string): void { if (this.phase === "attached") this.attached?.input(`${text}\r`); }
}
