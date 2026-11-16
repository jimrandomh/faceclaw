/**
 * tmux backend for the Terminal app: lists, watches, views and types into
 * tmux panes on an SSH host, presenting them through the same TerminalClient
 * model as g2mirror sessions (each pane is one "session"; its pane id, e.g.
 * "%12", plays the part of g2mirror's session socket).
 *
 * Two kinds of channel run on the host, both opened through `openChannel`
 * (an SSH exec channel in the app, a local process in tests):
 *
 * - The poller: a /bin/sh loop that prints the tmux version and host name,
 *   then every 2 s lists every pane of every session (only when the listing
 *   changed). It also (re)installs an alert-bell hook that counts bells per
 *   window in the @faceclaw_bells window option: tmux's own bell flag misses
 *   bells in a session's current window, and this way bells that ring while
 *   we're disconnected still show up as a higher count. Bell, activity and
 *   title notifications come from diffing successive listings.
 *
 * - The viewer (after connectSession): a tmux control-mode client
 *   (`tmux -C attach-session`) on the pane's session. It never changes the
 *   session's current window or active pane, so a desktop client attached to
 *   the same session is undisturbed. Viewing sets a per-window size for this
 *   client (`refresh-client -C @W:WxH`, which resizes the window to the
 *   glasses while we look, and restores it when cleared), snapshots the pane
 *   with capture-pane, and then applies its %output stream. Unviewing pauses
 *   the pane's output to this client (`refresh-client -A %N:pause`; "off"
 *   would make tmux stop reading the pane altogether when no other client
 *   wants it, stalling the program). Output from the session's other panes is
 *   paused as soon as it shows up.
 *
 * Requires tmux 3.2+ (control-mode pause/continue and per-window sizes);
 * older versions get a message asking for an upgrade. 3.8's history_added /
 * history_collected make scrollback paging exact; before that it assumes
 * the history hasn't hit its limit since the snapshot.
 */
import type { G2MirrorHistoryReply, G2MirrorPhase, G2MirrorSession, G2MirrorState } from "./terminal-client";

export const TMUX_MIN_VERSION: [number, number] = [3, 2];

export type LineChannelListener = {
  onOpen(): void;
  /** One stdout line (see native/ssh escapeLine for non-UTF-8 lines). */
  onLine(line: string): void;
  onStderr(line: string): void;
  onClosed(exitStatus: number | null): void;
  onFailure(message: string): void;
};

export type LineChannel = {
  send(line: string): boolean;
  close(): void;
};

/** Run `command` on the host (through the user's login shell, like ssh does). */
export type OpenLineChannel = (command: string, listener: LineChannelListener) => LineChannel;

export type TmuxClientOptions = {
  openChannel: OpenLineChannel;
  /** How status lines name the host, e.g. "jim@laptop". */
  label: string;
  /** Grid the glasses view sessions at. */
  cols: number;
  rows: number;
  /**
   * Remembers per-window bell counts across client instances (the worker
   * makes a new client per reconnect), so a bell that rang while we were
   * disconnected is still reported. The connection id for the client that
   * watches bells; "" (counts kept per instance) for view clients, which
   * mustn't consume bells the watching client hasn't seen yet.
   */
  stateKey: string;
};

const POLL_INTERVAL_S = 2;
const BELL_HOOK_INDEX = 7091;
const LAUNCH_TIMEOUT_MS = 15_000;
const SUBMIT_DELAY_MS = 150;
// send-keys -H takes one argument per byte; keep command lines modest.
const SEND_KEYS_CHUNK_BYTES = 256;
// How many listings connectSession waits for a just-launched pane to appear.
const CONNECT_WAIT_POLLS = 4;

// ---- host-side scripts ----

const TMUX_CANDIDATES = [
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  '"$HOME/.local/bin/tmux"',
  '"$HOME/bin/tmux"',
  "/home/linuxbrew/.linuxbrew/bin/tmux",
  '"$HOME/.nix-profile/bin/tmux"',
  "/run/current-system/sw/bin/tmux",
  "/snap/bin/tmux",
];

/**
 * Wrap a /bin/sh script as an exec command. The command runs under the
 * user's login shell, which may be bash, zsh, fish or csh, so it stays a
 * single line whose only quoting is one pair of single quotes, and the
 * script may contain neither single quotes nor "\\" (fish treats \\ and \'
 * specially inside single quotes; any other backslash is literal in all of
 * them).
 */
export function hostCommand(script: string): string {
  if (script.includes("'") || script.includes("\\\\") || /[\r\n]/.test(script)) {
    throw new Error("host script contains characters that can't be quoted portably");
  }
  return `exec /bin/sh -c '${script}'`;
}

/**
 * Sets T to the tmux binary: PATH as the exec shell sees it, then PATH as a
 * login shell sees it (Homebrew/Nix/~/.local installs are often only on the
 * login PATH), then common install locations.
 */
function locateTmux(): string {
  return [
    "T=$(command -v tmux 2>/dev/null)",
    '[ -x "$T" ] || T=$("${SHELL:-/bin/sh}" -lc "command -v tmux" 2>/dev/null </dev/null | tail -n 1)',
    `for c in ${TMUX_CANDIDATES.join(" ")}; do [ -x "$T" ] && break; T=$c; done`,
    '[ -x "$T" ] || { echo FACECLAW-NO-TMUX; exit 127; }',
  ].join("; ");
}

// Listing fields, tab-separated, title last (it may contain tabs itself).
const PANE_FIELDS = [
  "#{pane_id}",
  "#{session_id}",
  "#{session_name}",
  "#{window_id}",
  "#{window_index}",
  "#{window_name}",
  "#{window_panes}",
  "#{pane_index}",
  "#{pane_pid}",
  "#{pane_dead}",
  // Per-pane output time (3.8+), else per-window activity; seconds either way.
  "#{?pane_last_output_time,#{pane_last_output_time},#{window_activity}}",
  "#{@faceclaw_bells}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{pane_title}",
];

export function pollerCommand(): string {
  const format = PANE_FIELDS.join("\t");
  const hook = 'set -wF @faceclaw_bells \\"#{e|+:#{@faceclaw_bells},1}\\"';
  return hostCommand(
    [
      locateTmux(),
      'echo "FACECLAW-TMUX $("$T" -V 2>&1)"',
      'echo "FACECLAW-HOST $(hostname 2>/dev/null)"',
      'echo "FACECLAW-HOME $HOME"',
      `F="${format}"`,
      `H="${hook}"`,
      "P=-",
      // Print the listing only when it changed. No server running: the
      // listing is empty.
      `while :; do O=$("$T" set-hook -g "alert-bell[${BELL_HOOK_INDEX}]" "$H" \\; list-panes -a -F "$F" 2>/dev/null); ` +
        `if [ "$O" != "$P" ]; then echo FACECLAW-BEGIN; printf "%s\\n" "$O"; echo FACECLAW-END; P=$O; fi; sleep ${POLL_INTERVAL_S}; done`,
    ].join("; "),
  );
}

export function viewerCommand(sessionId: string): string {
  if (!/^\$\d+$/.test(sessionId)) throw new Error(`bad tmux session id ${sessionId}`);
  // "\$" keeps /bin/sh from expanding the session id ($3) as a variable.
  return hostCommand(`${locateTmux()}; exec "$T" -C attach-session -t "\\${sessionId}"`);
}

const SAFE_LAUNCH_COMMAND = /^[A-Za-z0-9 ._/+:=@%,-]+$/;

/** New detached session running `preset` ("shell" or "": the default shell). */
export function launchCommand(preset: string): string {
  const command = preset === "shell" ? "" : preset.trim();
  if (command && !SAFE_LAUNCH_COMMAND.test(command)) {
    throw new Error(`Launch preset "${preset}" has characters that can't be passed to tmux.`);
  }
  return hostCommand(
    `${locateTmux()}; exec "$T" new-session -d -P -F "FACECLAW-LAUNCHED #{pane_id} #{session_id}"${command ? ` "${command}"` : ""}`,
  );
}

// ---- parsing helpers ----

/** Parse `tmux -V` output; null for builds without a numeric version (master), treated as new. */
export function parseTmuxVersion(text: string): [number, number] | null {
  const match = /(\d+)\.(\d+)/.exec(text);
  return match ? [parseInt(match[1]!, 10), parseInt(match[2]!, 10)] : null;
}

export function tmuxVersionSupported(text: string): boolean {
  const version = parseTmuxVersion(text);
  if (!version) return true;
  const [major, minor] = version;
  return major > TMUX_MIN_VERSION[0] || (major === TMUX_MIN_VERSION[0] && minor >= TMUX_MIN_VERSION[1]);
}

export type PaneRow = {
  paneId: string;
  sessionId: string;
  sessionName: string;
  windowId: string;
  windowIndex: string;
  windowName: string;
  windowPanes: number;
  paneIndex: string;
  pid: number;
  dead: boolean;
  /** Last output (or window activity), seconds, host clock. */
  activity: number;
  bells: number;
  command: string;
  path: string;
  title: string;
};

export function parsePaneRow(line: string): PaneRow | null {
  const fields = line.split("\t");
  if (fields.length < PANE_FIELDS.length || !fields[0]!.startsWith("%")) return null;
  const title = fields.slice(PANE_FIELDS.length - 1).join("\t");
  return {
    paneId: fields[0]!,
    sessionId: fields[1]!,
    sessionName: fields[2]!,
    windowId: fields[3]!,
    windowIndex: fields[4]!,
    windowName: fields[5]!,
    windowPanes: parseInt(fields[6]!, 10) || 1,
    paneIndex: fields[7]!,
    pid: parseInt(fields[8]!, 10) || 0,
    dead: fields[9] === "1",
    activity: parseInt(fields[10]!, 10) || 0,
    bells: parseInt(fields[11]!, 10) || 0,
    command: fields[12]!,
    path: fields[13]!,
    title,
  };
}

/**
 * A row's label in the session list: "session:window[.pane] <title>", where
 * the title is what the program set (OSC 0/2) or, when it hasn't set one
 * (tmux's default title is the host name), the running command and its
 * directory.
 */
export function paneLabel(row: PaneRow, hostName: string, home: string): string {
  const where = `${row.sessionName}:${row.windowIndex}${row.windowPanes > 1 ? `.${row.paneIndex}` : ""}`;
  const shortHost = hostName.split(".")[0] ?? "";
  const meaningfulTitle = row.title && row.title !== hostName && row.title !== shortHost ? row.title : "";
  if (meaningfulTitle) return `${where} ${meaningfulTitle}`;
  const path = home && (row.path === home || row.path.startsWith(`${home}/`)) ? `~${row.path.slice(home.length)}` : row.path;
  return `${where} ${row.command}${path ? ` ${path}` : ""}`;
}

/**
 * Decode a tmux control-mode %output value to bytes: "\ooo" is an octal
 * byte (tmux escapes control characters and backslashes this way, and the
 * SSH transport escapes bytes of lines that aren't valid UTF-8 the same
 * way); any other character is UTF-8 encoded.
 */
export function decodeTmuxOutput(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x5c && i + 3 < value.length && /^[0-7]{3}$/.test(value.slice(i + 1, i + 4))) {
      bytes.push(parseInt(value.slice(i + 1, i + 4), 8) & 0xff);
      i += 3;
      continue;
    }
    pushUtf8(bytes, value, i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) i++;
  }
  return Uint8Array.from(bytes);
}

function pushUtf8(bytes: number[], text: string, index: number): void {
  const point = text.codePointAt(index)!;
  if (point < 0x80) bytes.push(point);
  else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
  else if (point < 0x10000) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
  else
    bytes.push(
      0xf0 | (point >> 18),
      0x80 | ((point >> 12) & 0x3f),
      0x80 | ((point >> 6) & 0x3f),
      0x80 | (point & 0x3f),
    );
}

export function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    pushUtf8(bytes, text, i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) i++;
  }
  return Uint8Array.from(bytes);
}

// Pane state read for a snapshot, '|'-separated (all numeric but the id).
const SNAPSHOT_FIELDS = [
  "#{pane_id}",
  "#{cursor_x}",
  "#{cursor_y}",
  "#{cursor_flag}",
  "#{keypad_cursor_flag}",
  "#{keypad_flag}",
  "#{wrap_flag}",
  "#{insert_flag}",
  "#{alternate_on}",
  "#{scroll_region_upper}",
  "#{scroll_region_lower}",
  "#{pane_width}",
  "#{pane_height}",
  "#{history_size}",
  "#{history_added}",
  "#{history_collected}",
  "#{history_generation}",
];

export type PaneState = {
  paneId: string;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  appCursorKeys: boolean;
  appKeypad: boolean;
  wrap: boolean;
  insert: boolean;
  alternate: boolean;
  scrollUpper: number;
  scrollLower: number;
  width: number;
  height: number;
  /** Absolute index of the next line to enter the history (history_added, else history_size). */
  historyNext: number;
  /** Oldest retained absolute index (history_collected, else 0). */
  historyOldest: number;
  generation: string;
};

export function parsePaneState(line: string): PaneState | null {
  const f = line.split("|");
  if (f.length < SNAPSHOT_FIELDS.length || !f[0]!.startsWith("%")) return null;
  const n = (index: number) => parseInt(f[index]!, 10) || 0;
  const exact = f[14] !== "";
  return {
    paneId: f[0]!,
    cursorX: n(1),
    cursorY: n(2),
    cursorVisible: f[3] !== "0",
    appCursorKeys: f[4] === "1",
    appKeypad: f[5] === "1",
    wrap: f[6] !== "0",
    insert: f[7] === "1",
    alternate: f[8] === "1",
    scrollUpper: n(9),
    scrollLower: n(10),
    width: n(11),
    height: n(12),
    historyNext: exact ? n(14) : n(13),
    historyOldest: exact ? n(15) : 0,
    generation: f[16] ?? "",
  };
}

/**
 * Terminal bytes that recreate a captured pane in a freshly reset emulator:
 * the normal screen (when the pane is in the alternate screen), the visible
 * lines, then cursor position and the modes that change how keys encode.
 */
export function snapshotBytes(state: PaneState, visible: string[], normalScreen: string[]): Uint8Array {
  let out = "";
  const rows = (lines: string[]) => lines.slice(0, Math.max(1, state.height)).join("\x1b[0m\r\n");
  if (state.alternate) {
    out += rows(normalScreen) + "\x1b[0m\x1b[?1049h\x1b[H";
  }
  out += rows(visible) + "\x1b[0m";
  if (state.scrollUpper !== 0 || state.scrollLower !== state.height - 1) {
    out += `\x1b[${state.scrollUpper + 1};${state.scrollLower + 1}r`;
  }
  out += `\x1b[${state.cursorY + 1};${state.cursorX + 1}H`;
  if (!state.cursorVisible) out += "\x1b[?25l";
  if (state.appCursorKeys) out += "\x1b[?1h";
  if (state.appKeypad) out += "\x1b=";
  if (!state.wrap) out += "\x1b[?7l";
  if (state.insert) out += "\x1b[4h";
  return encodeUtf8(out);
}

/** send-keys -H commands typing `bytes` into pane `paneId`. */
export function sendKeysCommands(paneId: string, bytes: Uint8Array): string[] {
  const commands: string[] = [];
  for (let start = 0; start < bytes.length; start += SEND_KEYS_CHUNK_BYTES) {
    const hex = Array.from(bytes.subarray(start, start + SEND_KEYS_CHUNK_BYTES), (byte) => byte.toString(16).padStart(2, "0"));
    commands.push(`send-keys -t ${paneId} -H ${hex.join(" ")}`);
  }
  return commands;
}

// ---- client ----

type Block = { ok: boolean; lines: string[] };
type PendingCommands = { count: number; blocks: Block[]; done: (blocks: Block[]) => void };
type BellMemory = Map<string, { count: number; lastBellAt: number | null }>;

const bellMemoryByKey = new Map<string, BellMemory>();

export class TmuxClient {
  private phase: G2MirrorPhase = "idle";
  private status = "Not connected.";
  private retryable = true;
  private stopped = false;
  private generation = 0;

  private poller: LineChannel | null = null;
  private pollerLines: string[] | null = null;
  private versionText = "";
  private hostName = "";
  private home = "";
  private rows = new Map<string, PaneRow>();
  private sessions: G2MirrorSession[] = [];
  private listings = 0;
  private pendingConnect: { paneId: string; deadline: number } | null = null;

  private viewer: LineChannel | null = null;
  private attachedPane: PaneRow | null = null;
  private viewing = false;
  private sizeDirty = false;
  private snapshotInFlight = false;
  private snapshotGeneration = "";
  private pausedPanes = new Set<string>();
  private pending: PendingCommands[] = [];
  private block: { time: string; number: string; ours: boolean; lines: string[] } | null = null;
  private liveCheckInFlight = false;
  private readonly localBellMemory: BellMemory = new Map();

  private readonly stateListeners = new Set<(state: G2MirrorState) => void>();
  private readonly terminalDataListeners = new Set<(data: Uint8Array, kind: "snapshot" | "output") => void>();
  private readonly snapshotListeners = new Set<(historyNext: number, historyOldest: number) => void>();
  private readonly historyListeners = new Set<(reply: G2MirrorHistoryReply) => void>();
  private readonly attachedListeners = new Set<(command: string) => void>();
  private readonly detachedListeners = new Set<(reason: string) => void>();
  private readonly bellListeners = new Set<(socket: string, lastBellAtMs: number) => void>();
  private readonly activityListeners = new Set<(socket: string, lastOutputAtMs: number) => void>();
  private readonly titleListeners = new Set<(socket: string, title: string) => void>();

  constructor(private readonly options: TmuxClientOptions) {}

  state(): G2MirrorState & { retryable: boolean } {
    return {
      phase: this.phase,
      status: this.status,
      sessions: this.sessions.slice(),
      attachedCommand: this.attachedPane ? this.labelFor(this.attachedPane) : "",
      serverName: this.hostName,
      retryable: this.retryable,
    };
  }

  onStateChange(listener: (state: G2MirrorState) => void): () => void {
    return subscribe(this.stateListeners, listener);
  }
  onTerminalData(listener: (data: Uint8Array, kind: "snapshot" | "output") => void): () => void {
    return subscribe(this.terminalDataListeners, listener);
  }
  onSnapshot(listener: (historyNext: number, historyOldest: number) => void): () => void {
    return subscribe(this.snapshotListeners, listener);
  }
  onHistoryLines(listener: (reply: G2MirrorHistoryReply) => void): () => void {
    return subscribe(this.historyListeners, listener);
  }
  onSessionAttached(listener: (command: string) => void): () => void {
    return subscribe(this.attachedListeners, listener);
  }
  onSessionDetached(listener: (reason: string) => void): () => void {
    return subscribe(this.detachedListeners, listener);
  }
  onBell(listener: (socket: string, lastBellAtMs: number) => void): () => void {
    return subscribe(this.bellListeners, listener);
  }
  onActivity(listener: (socket: string, lastOutputAtMs: number) => void): () => void {
    return subscribe(this.activityListeners, listener);
  }
  onTitle(listener: (socket: string, title: string) => void): () => void {
    return subscribe(this.titleListeners, listener);
  }

  setViewport(cols: number, rows: number): void {
    if (cols === this.options.cols && rows === this.options.rows) return;
    this.options.cols = cols;
    this.options.rows = rows;
    if (this.viewing) this.snapshot();
  }

  start(): void {
    if (this.poller || this.viewer) return;
    this.stopped = false;
    this.retryable = true;
    this.resetSessionState();
    this.setState("connecting", `Connecting to ${this.options.label}...`);
    this.openPoller();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.viewer && this.attachedPane && this.viewing) {
      // Best effort: give the window back its own size before detaching.
      this.viewer.send(`refresh-client -C ${this.attachedPane.windowId}:`);
    }
    this.closeChannels();
    this.resetSessionState();
    this.setState("idle", "Not connected.");
  }

  listSessions(): void {
    // The poller pushes every change; nothing to ask for.
  }

  launchSession(preset: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.phase !== "connected" && this.phase !== "attached") {
        reject(new Error("Not connected to tmux."));
        return;
      }
      let command: string;
      try {
        command = launchCommand(preset);
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      let channel: LineChannel | null = null;
      const errors: string[] = [];
      const finish = (error: Error | null, paneId?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel?.close();
        if (error) reject(error);
        else resolve(paneId!);
      };
      const timer = setTimeout(() => finish(new Error(`Launch of "${preset}" timed out.`)), LAUNCH_TIMEOUT_MS);
      channel = this.options.openChannel(command, {
        onOpen: () => {},
        onLine: (line) => {
          const match = /^FACECLAW-LAUNCHED (%\d+) (\$\d+)$/.exec(line);
          if (match) finish(null, match[1]);
          else if (line === "FACECLAW-NO-TMUX") finish(new Error("tmux is not installed on the host."));
        },
        onStderr: (line) => errors.push(line),
        onClosed: () => finish(new Error(errors.join(" ") || `Launch of "${preset}" failed.`)),
        onFailure: (message) => finish(new Error(message)),
      });
      if (settled) channel.close();
    });
  }

  connectSession(paneId: string): void {
    if (this.phase !== "connected") return;
    const row = this.rows.get(paneId);
    if (!row) {
      // Just launched, perhaps: wait a few listings for it to show up.
      this.pendingConnect = { paneId, deadline: this.listings + CONNECT_WAIT_POLLS };
      this.setState(this.phase, "Waiting for the session...");
      return;
    }
    this.pendingConnect = null;
    this.openViewer(row);
  }

  disconnectSession(): void {
    if (this.phase !== "attached") return;
    this.unview();
    this.viewer?.close();
    this.viewer = null;
    this.attachedPane = null;
    this.setState("idle", "Detached.");
  }

  view(): void {
    if (this.phase !== "attached" || !this.attachedPane) return;
    this.viewing = true;
    this.snapshot();
  }

  unview(): void {
    if (this.phase !== "attached" || !this.attachedPane || !this.viewing) return;
    this.viewing = false;
    const pane = this.attachedPane;
    this.command([`refresh-client -A '${pane.paneId}:pause'`, `refresh-client -C ${pane.windowId}:`]);
  }

  requestHistory(before: number, limit = 200): void {
    if (this.phase !== "attached" || !this.attachedPane) return;
    void this.fetchHistory(this.attachedPane, before, limit);
  }

  sendInput(text: string): void {
    if (this.phase !== "attached" || !this.attachedPane || !text) return;
    if (this.sizeDirty && this.viewing) {
      // Someone else resized the window since we sized it (window-size
      // "latest" follows the most recently active client). Typing here makes
      // us the active one again: take the size back and resync.
      this.snapshot();
    }
    this.command(sendKeysCommands(this.attachedPane.paneId, encodeUtf8(text)));
  }

  submitInput(text: string): void {
    if (this.phase !== "attached") return;
    // Like g2mirror's `delays`: a pause before Enter so paste-detecting apps
    // (Claude Code) read it as a keypress, not the tail of a paste.
    if (text) this.sendInput(text);
    const generation = this.generation;
    setTimeout(() => {
      if (generation === this.generation) this.sendInput("\r");
    }, text ? SUBMIT_DELAY_MS : 0);
  }

  // ---- poller ----

  private openPoller(): void {
    const generation = this.generation;
    const stderr: string[] = [];
    this.poller = this.options.openChannel(pollerCommand(), {
      onOpen: () => {},
      onLine: (line) => {
        if (generation === this.generation) this.handlePollerLine(line);
      },
      onStderr: (line) => {
        stderr.push(line);
        if (stderr.length > 5) stderr.shift();
      },
      onClosed: (exitStatus) => {
        if (generation !== this.generation || this.phase === "failed") return;
        this.poller = null;
        if (this.phase === "attached") return; // the viewer carries on alone
        const detail = stderr.length ? `: ${stderr[stderr.length - 1]}` : exitStatus !== null ? ` (exit ${exitStatus})` : "";
        this.fail(`Session listing on ${this.options.label} ended${detail}`);
      },
      onFailure: (message) => {
        if (generation !== this.generation) return;
        this.poller = null;
        this.fail(message);
      },
    });
  }

  private handlePollerLine(line: string): void {
    if (this.pollerLines) {
      if (line === "FACECLAW-END") {
        this.applyListing(this.pollerLines);
        this.pollerLines = null;
      } else {
        this.pollerLines.push(line);
      }
      return;
    }
    if (line === "FACECLAW-BEGIN") {
      this.pollerLines = [];
    } else if (line === "FACECLAW-NO-TMUX") {
      this.retryable = false;
      this.fail(`tmux is not installed on ${this.options.label} (or not on the login shell's PATH).`);
    } else if (line.startsWith("FACECLAW-TMUX ")) {
      this.versionText = line.slice("FACECLAW-TMUX ".length).trim();
      if (!tmuxVersionSupported(this.versionText)) {
        this.retryable = false;
        this.fail(
          `${this.versionText || "tmux"} on ${this.options.label} is too old; Faceclaw needs tmux ${TMUX_MIN_VERSION.join(".")} or newer. Please upgrade it.`,
        );
      }
    } else if (line.startsWith("FACECLAW-HOST ")) {
      this.hostName = line.slice("FACECLAW-HOST ".length).trim();
    } else if (line.startsWith("FACECLAW-HOME ")) {
      this.home = line.slice("FACECLAW-HOME ".length).trim();
    }
  }

  private applyListing(lines: string[]): void {
    const now = Date.now();
    const previous = this.rows;
    const firstListing = this.listings === 0;
    this.listings++;
    const memory = this.options.stateKey ? bellMemoryFor(this.options.stateKey) : this.localBellMemory;
    const rows = new Map<string, PaneRow>();
    const bellsByWindow = new Map<string, number>();
    for (const line of lines) {
      const row = parsePaneRow(line);
      if (!row || rows.has(row.paneId)) continue;
      rows.set(row.paneId, row);
      bellsByWindow.set(row.windowId, row.bells);
    }
    // Bells are counted per window. A count above the remembered one is a
    // bell (possibly one that rang while we were away); a lower one means the
    // tmux server restarted and reused the id.
    const belledWindows = new Set<string>();
    for (const [windowId, count] of bellsByWindow) {
      const known = memory.get(windowId);
      if (!known) {
        memory.set(windowId, { count, lastBellAt: null });
      } else if (count > known.count) {
        memory.set(windowId, { count, lastBellAt: now });
        belledWindows.add(windowId);
      } else if (count < known.count) {
        memory.set(windowId, { count, lastBellAt: known.lastBellAt });
      }
    }
    this.rows = rows;
    this.sessions = [...rows.values()]
      .filter((row) => !row.dead)
      .map((row) => ({
        socket: row.paneId,
        pid: row.pid,
        cwdHint: row.path.replace(/\//g, "_"),
        lastBellAt: memory.get(row.windowId)?.lastBellAt ?? null,
        lastOutputAt: row.activity ? row.activity * 1000 : null,
        title: this.labelFor(row),
      }));
    if (this.phase === "connecting") {
      this.setState("connected", `Connected to ${this.options.label} (${this.versionText || "tmux"}).`);
    } else {
      this.emitState();
    }
    if (!firstListing) {
      for (const row of rows.values()) {
        const before = previous.get(row.paneId);
        if (belledWindows.has(row.windowId)) {
          const at = memory.get(row.windowId)?.lastBellAt ?? now;
          for (const listener of this.bellListeners) listener(row.paneId, at);
        }
        if (before && row.activity > before.activity) {
          for (const listener of this.activityListeners) listener(row.paneId, row.activity * 1000);
        }
        if (before && row.title !== before.title) {
          for (const listener of this.titleListeners) listener(row.paneId, this.labelFor(row));
        }
      }
    }
    if (this.pendingConnect) {
      const { paneId, deadline } = this.pendingConnect;
      const row = rows.get(paneId);
      if (row) {
        this.pendingConnect = null;
        this.openViewer(row);
      } else if (this.listings >= deadline) {
        this.pendingConnect = null;
        this.setState("connected", "That session no longer exists.");
        for (const listener of this.detachedListeners) listener("session not found");
      }
    }
  }

  private labelFor(row: PaneRow): string {
    return paneLabel(row, this.hostName, this.home);
  }

  // ---- viewer ----

  private openViewer(row: PaneRow): void {
    const generation = this.generation;
    let command: string;
    try {
      command = viewerCommand(row.sessionId);
    } catch (error) {
      this.fail(String((error as Error).message ?? error));
      return;
    }
    this.attachedPane = row;
    this.pausedPanes.clear();
    this.pending = [];
    this.block = null;
    this.setState("connected", "Attaching to session...");
    const stderr: string[] = [];
    let attached = false;
    let attachError = "";
    this.viewer = this.options.openChannel(command, {
      onOpen: () => {},
      onLine: (line) => {
        if (generation !== this.generation) return;
        if (!attached) {
          // The attach-session command's own reply block: %end means tmux
          // attached us, %error (then %exit) that the session is gone.
          if (line.startsWith("%end ")) {
            attached = true;
            // The view needs no listings from here on.
            this.poller?.close();
            this.poller = null;
            this.setState("attached", `Attached to ${this.labelFor(row)}.`);
            for (const listener of this.attachedListeners) listener(this.labelFor(row));
          } else if (!line.startsWith("%") && !attachError) {
            attachError = line;
          }
          return;
        }
        this.handleControlLine(line);
      },
      onStderr: (line) => {
        stderr.push(line);
        if (stderr.length > 5) stderr.shift();
      },
      onClosed: () => {
        if (generation !== this.generation) return;
        this.viewer = null;
        if (!attached && attachError) {
          // E.g. "can't find session": it ended between listing and attaching.
          this.generation++;
          this.closeChannels();
          this.attachedPane = null;
          this.setState("connected", `That session no longer exists (${attachError}).`);
          for (const listener of this.detachedListeners) listener("session not found");
          return;
        }
        if (!attached) {
          this.fail(stderr.length ? `tmux: ${stderr[stderr.length - 1]}` : "tmux refused to attach.");
          return;
        }
        this.sessionEnded("tmux client exited");
      },
      onFailure: (message) => {
        if (generation !== this.generation) return;
        this.viewer = null;
        this.fail(message);
      },
    });
  }

  private handleControlLine(line: string): void {
    const block = this.block;
    if (block) {
      if (line.startsWith("%end ") || line.startsWith("%error ")) {
        const [, time, number] = line.split(" ");
        if (time === block.time && number === block.number) {
          this.block = null;
          if (block.ours) this.finishBlock({ ok: line.startsWith("%end "), lines: block.lines });
          return;
        }
      }
      block.lines.push(line);
      return;
    }
    const space = line.indexOf(" ");
    const kind = space < 0 ? line : line.slice(0, space);
    switch (kind) {
      case "%begin": {
        const [, time, number, flags] = line.split(" ");
        // flags 1: a command this client sent (0: e.g. the initial attach).
        this.block = { time: time ?? "", number: number ?? "", ours: flags === "1", lines: [] };
        return;
      }
      case "%output": {
        const second = line.indexOf(" ", space + 1);
        if (second < 0) return;
        this.handleOutput(line.slice(space + 1, second), line.slice(second + 1));
        return;
      }
      case "%exit":
        this.sessionEnded(line.length > 6 ? line.slice(6) : "tmux session ended");
        return;
      case "%layout-change": {
        const [, windowId, layout] = line.split(" ");
        const pane = this.attachedPane;
        if (pane && windowId === pane.windowId) {
          const size = /^[0-9a-f]{4},(\d+)x(\d+),/.exec(layout ?? "");
          if (size && this.viewing && (+size[1]! !== this.options.cols || +size[2]! !== this.options.rows)) {
            this.sizeDirty = true;
          }
          this.checkPaneAlive();
        }
        return;
      }
      case "%window-close":
      case "%unlinked-window-close":
      case "%window-pane-changed":
      case "%session-changed":
        this.checkPaneAlive();
        return;
      default:
        // %session-renamed, %window-renamed, %pause, %continue, ...
        return;
    }
  }

  private handleOutput(paneId: string, value: string): void {
    const pane = this.attachedPane;
    if (!pane || paneId !== pane.paneId) {
      // Another pane in the attached session: we never show it, so stop tmux
      // sending it to us.
      if (!this.pausedPanes.has(paneId) && /^%\d+$/.test(paneId)) {
        this.pausedPanes.add(paneId);
        this.command([`refresh-client -A '${paneId}:pause'`]);
      }
      return;
    }
    // Output that arrives before a snapshot's capture is already in it.
    if (!this.viewing || this.snapshotInFlight) return;
    const bytes = decodeTmuxOutput(value);
    for (const listener of this.terminalDataListeners) listener(bytes, "output");
  }

  private finishBlock(block: Block): void {
    const pending = this.pending[0];
    if (!pending) return;
    pending.blocks.push(block);
    if (pending.blocks.length >= pending.count) {
      this.pending.shift();
      pending.done(pending.blocks);
    }
  }

  /**
   * Send commands as one line (tmux runs them back to back, so e.g. a
   * capture and the state read with it are consistent); `done` gets one
   * block per command, synchronously as the last one arrives — before any
   * later %output line is handled — or [] if the viewer went away.
   */
  private command(commands: string[], done: (blocks: Block[]) => void = () => {}): void {
    if (!this.viewer || !commands.length) {
      done([]);
      return;
    }
    this.pending.push({ count: commands.length, blocks: [], done });
    if (!this.viewer.send(commands.join(" ; "))) {
      this.pending.pop();
      done([]);
    }
  }

  private commandAsync(commands: string[]): Promise<Block[]> {
    return new Promise((resolve) => this.command(commands, resolve));
  }

  private snapshot(): void {
    const pane = this.attachedPane;
    if (!pane || this.snapshotInFlight) return;
    this.snapshotInFlight = true;
    this.sizeDirty = false;
    const generation = this.generation;
    const { cols, rows } = this.options;
    this.command([
      `refresh-client -C ${pane.windowId}:${cols}x${rows}`,
      `refresh-client -A '${pane.paneId}:continue'`,
      `display -p -t ${pane.paneId} '${SNAPSHOT_FIELDS.join("|")}'`,
      `capture-pane -p -e -t ${pane.paneId}`,
      `capture-pane -p -e -a -q -t ${pane.paneId}`,
    ], (blocks) => {
      if (generation !== this.generation) return;
      this.snapshotInFlight = false;
      if (blocks.length < 5 || !this.viewing) return;
      const state = parsePaneState(blocks[2]!.lines[0] ?? "");
      if (!state || state.paneId !== pane.paneId) {
        this.sessionEnded("session closed");
        return;
      }
      this.snapshotGeneration = state.generation;
      const data = snapshotBytes(state, blocks[3]!.lines, blocks[4]!.ok ? blocks[4]!.lines : []);
      for (const listener of this.terminalDataListeners) listener(data, "snapshot");
      for (const listener of this.snapshotListeners) listener(state.historyNext, state.historyOldest);
    });
  }

  private async fetchHistory(pane: PaneRow, before: number, limit: number): Promise<void> {
    const generation = this.generation;
    const stateCommand = `display -p -t ${pane.paneId} '${SNAPSHOT_FIELDS.join("|")}'`;
    let state = parsePaneState((await this.commandAsync([stateCommand]))[0]?.lines[0] ?? "");
    // Absolute index a is at capture-pane line (a - historyNext). If more
    // lines scroll into the history between our two requests, the offsets go
    // stale; the second request re-reads the state with the capture, so
    // retry until they agree.
    for (let attempt = 0; attempt < 3 && state && generation === this.generation; attempt++) {
      if (state.generation !== this.snapshotGeneration) {
        // History was cleared or reflowed: our indices mean nothing now.
        this.snapshot();
        return;
      }
      const start = Math.max(state.historyOldest, before - limit);
      const end = Math.min(before, state.historyNext);
      if (end <= start) {
        this.emitHistory({ start, oldest: state.historyOldest, next: state.historyNext, lines: [] });
        return;
      }
      const blocks = await this.commandAsync([
        stateCommand,
        `capture-pane -p -t ${pane.paneId} -S ${start - state.historyNext} -E ${end - 1 - state.historyNext}`,
      ]);
      if (generation !== this.generation || blocks.length < 2) return;
      const after = parsePaneState(blocks[0]!.lines[0] ?? "");
      if (after && after.historyNext === state.historyNext && after.generation === state.generation) {
        this.emitHistory({
          start,
          oldest: state.historyOldest,
          next: state.historyNext,
          lines: blocks[1]!.ok ? blocks[1]!.lines.slice(0, end - start) : [],
        });
        return;
      }
      state = after;
    }
  }

  private emitHistory(reply: G2MirrorHistoryReply): void {
    for (const listener of this.historyListeners) listener(reply);
  }

  /** Something structural changed: make sure our pane still exists. */
  private checkPaneAlive(): void {
    const pane = this.attachedPane;
    if (!pane || this.liveCheckInFlight) return;
    this.liveCheckInFlight = true;
    const generation = this.generation;
    this.command([`display -p -t ${pane.paneId} '#{pane_id} #{window_id}'`], (blocks) => {
      this.liveCheckInFlight = false;
      if (generation !== this.generation || !blocks.length) return;
      const [paneId, windowId] = (blocks[0]!.lines[0] ?? "").split(" ");
      if (paneId !== pane.paneId) {
        this.sessionEnded("session closed");
      } else if (windowId && windowId !== pane.windowId) {
        // The pane moved to another window (break-pane, move-pane).
        this.attachedPane = { ...pane, windowId };
        if (this.viewing) this.snapshot();
      }
    });
  }

  private sessionEnded(reason: string): void {
    if (this.phase !== "attached") return;
    this.generation++;
    this.closeChannels();
    this.attachedPane = null;
    this.viewing = false;
    this.setState("connected", `Session ended (${reason}).`);
    for (const listener of this.detachedListeners) listener(reason);
  }

  // ---- shared ----

  private fail(message: string): void {
    if (this.stopped) return;
    this.generation++;
    this.closeChannels();
    this.attachedPane = null;
    this.viewing = false;
    this.setState("failed", message);
  }

  private closeChannels(): void {
    this.poller?.close();
    this.poller = null;
    this.viewer?.close();
    this.viewer = null;
    for (const pending of this.pending.splice(0)) pending.done([]);
    this.block = null;
    this.snapshotInFlight = false;
    this.liveCheckInFlight = false;
  }

  private resetSessionState(): void {
    this.pollerLines = null;
    this.rows = new Map();
    this.sessions = [];
    this.listings = 0;
    this.pendingConnect = null;
    this.attachedPane = null;
    this.viewing = false;
    this.sizeDirty = false;
  }

  private setState(phase: G2MirrorPhase, status: string): void {
    this.phase = phase;
    this.status = status;
    this.emitState();
  }

  private emitState(): void {
    const state = this.state();
    for (const listener of this.stateListeners) listener(state);
  }
}

function bellMemoryFor(key: string): BellMemory {
  let memory = bellMemoryByKey.get(key);
  if (!memory) {
    memory = new Map();
    bellMemoryByKey.set(key, memory);
  }
  return memory;
}

function subscribe<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => set.delete(listener);
}
