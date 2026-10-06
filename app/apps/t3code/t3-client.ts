/**
 * One live connection to a paired T3 Code environment: fetches a WebSocket
 * ticket with the stored bearer token, opens the RPC socket, waits for the
 * server-config snapshot (checking it is the environment we paired with),
 * then keeps the thread list (subscribeShell) and any open threads
 * (subscribeThread) live. Owns its own retry loop: dropped connections come
 * back with jittered exponential backoff and resume every stream from its
 * last sequence. A rejected token stops retrying until the user pairs again.
 *
 * Transport and HTTP are injected, so this runs unchanged under Node.
 */
import {
  fetchWebSocketTicket,
  T3HttpError,
  webSocketUrl,
  type T3Fetch,
} from "./t3-auth";
import { ShellModel, ThreadDetailModel, type T3ServerProvider } from "./t3-model";
import { T3RpcConnection, T3RpcError, type RpcSocketFactory, type T3Subscription } from "./t3-rpc";

/** A paired environment as stored on the phone. */
export type StoredEnvironment = {
  /** Local id (stable across re-pairing). */
  id: string;
  /** The server's own id, checked on every connect. */
  environmentId: string;
  /** The server's label (its machine name). */
  label: string;
  httpBaseUrl: string;
  wsBaseUrl: string;
  /** Bearer token from pairing (30-day lifetime, no refresh). */
  accessToken: string;
  expiresAtMs: number;
  /** Connect while the app is open. */
  enabled: boolean;
};

export type EnvironmentPhase =
  | "idle"
  | "connecting"
  | "connected"
  /** Waiting to try again after a failure. */
  | "retrying"
  /** The token was rejected or expired: pair again. */
  | "auth-failed";

export type T3ClientDeps = {
  fetch: T3Fetch;
  openSocket: RpcSocketFactory;
  /** Reported to the server as the client OS ("Android", "iOS"). */
  clientOs: string;
  log?: (message: string) => void;
};

const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
/** How long the socket may stay open without delivering the config snapshot. */
const READY_TIMEOUT_MS = 20_000;
/** Resubscribe delay after a stream fails on a healthy connection (e.g. a server buffer overflow). */
const STREAM_RETRY_MS = 250;

export type ThreadHandle = {
  readonly model: ThreadDetailModel;
  /** The subscription failed for a reason other than the connection dropping. */
  readonly error: () => string;
  close(): void;
};

type ThreadEntry = {
  model: ThreadDetailModel;
  subscription: T3Subscription | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  error: string;
  listeners: Set<() => void>;
  refs: number;
};

export class T3EnvironmentClient {
  readonly shell = new ShellModel();
  providers: T3ServerProvider[] = [];
  settings: Record<string, any> | null = null;
  private phaseValue: EnvironmentPhase = "idle";
  private statusValue = "";
  private connection: T3RpcConnection | null = null;
  private shellSubscription: T3Subscription | null = null;
  private shellRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_MIN_DELAY_MS;
  /** Bumped on every connect attempt and stop, so stale async work can tell it lost. */
  private generation = 0;
  private running = false;
  private readonly listeners = new Set<() => void>();
  private readonly threads = new Map<string, ThreadEntry>();

  constructor(
    public config: StoredEnvironment,
    private readonly deps: T3ClientDeps,
  ) {}

  get phase(): EnvironmentPhase {
    return this.phaseValue;
  }

  /** Human-readable connection status ("" when connected and healthy). */
  get status(): string {
    return this.statusValue;
  }

  /** Connected, with the thread list loaded. */
  get ready(): boolean {
    return this.phaseValue === "connected" && this.shell.sequence !== null;
  }

  get retryScheduled(): boolean {
    return this.reconnectTimer !== null;
  }

  /** Any change worth repainting for: phase, status, thread list, config. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start connecting (no-op while already running). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.reconnectDelayMs = RECONNECT_MIN_DELAY_MS;
    void this.connect();
  }

  /** Disconnect and stop retrying. Open thread handles stay registered and resume on the next start. */
  stop(): void {
    this.running = false;
    this.generation++;
    this.clearTimers();
    this.teardownConnection("Disconnected.");
    this.setPhase("idle", "");
  }

  /** Retry right away (manual reconnect), resetting backoff. */
  retryNow(): void {
    this.stop();
    this.start();
  }

  /** Replace the stored config (e.g. re-paired); reconnects if anything connection-relevant changed. */
  updateConfig(config: StoredEnvironment): void {
    const reconnect =
      config.accessToken !== this.config.accessToken ||
      config.httpBaseUrl !== this.config.httpBaseUrl ||
      config.environmentId !== this.config.environmentId;
    this.config = config;
    if (reconnect && this.running) this.retryNow();
    else this.emit();
  }

  /**
   * Subscribe to a thread's detail stream. Handles are reference counted:
   * every openThread needs its own close().
   */
  openThread(threadId: string, onChange: () => void): ThreadHandle {
    let entry = this.threads.get(threadId);
    if (!entry) {
      entry = { model: new ThreadDetailModel(threadId), subscription: null, retryTimer: null, error: "", listeners: new Set(), refs: 0 };
      this.threads.set(threadId, entry);
      if (this.phaseValue === "connected") this.subscribeThread(threadId, entry);
    }
    const current = entry;
    current.refs++;
    current.listeners.add(onChange);
    let closed = false;
    return {
      model: current.model,
      error: () => current.error,
      close: () => {
        if (closed) return;
        closed = true;
        current.listeners.delete(onChange);
        if (--current.refs > 0) return;
        current.subscription?.cancel();
        if (current.retryTimer) clearTimeout(current.retryTimer);
        this.threads.delete(threadId);
      },
    };
  }

  /** orchestration.dispatchCommand; resolves to the committed event sequence. */
  async dispatch(command: Record<string, unknown>): Promise<number> {
    const connection = this.requireConnection();
    const result = await connection.call<{ sequence?: number }>("orchestration.dispatchCommand", command);
    return typeof result?.sequence === "number" ? result.sequence : 0;
  }

  /** orchestration.launchThread; resolves to the new thread's id. */
  async launchThread(payload: Record<string, unknown>): Promise<string> {
    const connection = this.requireConnection();
    const result = await connection.call<{ threadId?: string }>("orchestration.launchThread", payload);
    return String(result?.threadId ?? payload.threadId);
  }

  private requireConnection(): T3RpcConnection {
    if (this.phaseValue !== "connected" || !this.connection) {
      throw new T3RpcError("disconnected", `Not connected to ${this.config.label || "the server"}.`);
    }
    return this.connection;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.clearTimers();
    this.teardownConnection("Reconnecting.");
    if (this.config.expiresAtMs && this.config.expiresAtMs <= Date.now()) {
      this.setPhase("auth-failed", "Sign-in expired. Pair this device again.");
      return;
    }
    this.setPhase("connecting", "Connecting...");
    let ticket: string;
    try {
      ticket = await fetchWebSocketTicket(this.deps.fetch, this.config.httpBaseUrl, this.config.accessToken);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof T3HttpError && error.authFailed) {
        this.setPhase("auth-failed", error.message);
        return;
      }
      this.scheduleReconnect(errorMessage(error));
      return;
    }
    if (generation !== this.generation) return;

    const connection = new T3RpcConnection({
      url: webSocketUrl(this.config.wsBaseUrl, ticket, this.deps.clientOs),
      openSocket: this.deps.openSocket,
    });
    this.connection = connection;
    connection.onStateChange((state, reason) => {
      if (state !== "closed" || generation !== this.generation) return;
      this.handleConnectionLost(reason);
    });
    this.readyTimer = setTimeout(() => {
      if (generation === this.generation) connection.close("The server didn't finish connecting.");
    }, READY_TIMEOUT_MS);

    let ready = false;
    connection.subscribe(
      "subscribeServerConfig",
      {},
      (values) => {
        if (generation !== this.generation) return;
        for (const value of values) {
          const event = value as Record<string, any>;
          if (event?.type === "snapshot") {
            const config = event.config ?? {};
            const environmentId = config.environment?.environmentId;
            if (this.config.environmentId && environmentId && environmentId !== this.config.environmentId) {
              this.generation++;
              this.teardownConnection("Wrong server.");
              this.setPhase("auth-failed", "A different T3 Code server answered at this address. Pair it again.");
              return;
            }
            this.providers = Array.isArray(config.providers) ? config.providers : [];
            this.settings = config.settings ?? null;
            if (typeof config.environment?.label === "string" && config.environment.label && config.environment.label !== this.config.label) {
              this.config = { ...this.config, label: config.environment.label };
            }
            if (!ready) {
              ready = true;
              this.handleReady(generation);
            }
          } else if (event?.type === "providerStatuses" && Array.isArray(event.payload?.providers)) {
            this.providers = event.payload.providers;
          } else if (event?.type === "settingsUpdated" && event.payload?.settings) {
            this.settings = event.payload.settings;
          }
        }
        this.emit();
      },
      (error) => {
        // The session is unusable without its config stream (T3's own client
        // treats this as the session closing).
        if (generation !== this.generation || error?.kind === "disconnected") return;
        connection.close(`Server config stream ended${error ? `: ${error.message}` : "."}`);
      },
    );
  }

  private handleReady(generation: number): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.reconnectDelayMs = RECONNECT_MIN_DELAY_MS;
    this.setPhase("connected", "");
    this.deps.log?.(`t3code: connected to ${this.config.label} (${this.config.httpBaseUrl})`);
    this.subscribeShell(generation);
    for (const [threadId, entry] of this.threads) this.subscribeThread(threadId, entry);
  }

  private subscribeShell(generation: number): void {
    const connection = this.connection;
    if (!connection || generation !== this.generation) return;
    this.shell.synchronized = false;
    this.shellSubscription?.cancel();
    const payload: Record<string, unknown> = { requestCompletionMarker: true };
    if (this.shell.sequence !== null) payload.afterSequence = this.shell.sequence;
    this.shellSubscription = connection.subscribe(
      "orchestration.subscribeShell",
      payload,
      (values) => {
        if (generation !== this.generation) return;
        let changed = false;
        for (const value of values) changed = this.shell.apply(value) || changed;
        if (changed) this.emit();
      },
      (error) => {
        this.shellSubscription = null;
        if (generation !== this.generation || error?.kind === "disconnected") return;
        this.deps.log?.(`t3code: shell stream ended: ${error?.message ?? "completed"}`);
        this.shellRetryTimer = setTimeout(() => {
          this.shellRetryTimer = null;
          this.subscribeShell(generation);
        }, STREAM_RETRY_MS);
      },
    );
  }

  private subscribeThread(threadId: string, entry: ThreadEntry): void {
    const connection = this.connection;
    if (!connection || this.phaseValue !== "connected") return;
    const generation = this.generation;
    entry.subscription?.cancel();
    entry.model.synchronized = false;
    const payload: Record<string, unknown> = { threadId, requestCompletionMarker: true, acceptBoundedSnapshot: true };
    if (entry.model.sequence !== null) payload.afterSequence = entry.model.sequence;
    const notify = () => {
      for (const listener of [...entry.listeners]) listener();
    };
    const subscription = connection.subscribe(
      "orchestration.subscribeThread",
      payload,
      (values) => {
        if (generation !== this.generation || this.threads.get(threadId) !== entry) return;
        let changed = false;
        for (const value of values) changed = entry.model.apply(value) || changed;
        if (entry.error) {
          entry.error = "";
          changed = true;
        }
        if (changed) notify();
      },
      (error) => {
        if (entry.subscription === subscription) entry.subscription = null;
        if (generation !== this.generation || this.threads.get(threadId) !== entry || error?.kind === "disconnected") return;
        entry.error = error ? error.message : "The thread stream ended.";
        notify();
        if (error?.kind === "fail" || error?.kind === "interrupt") {
          entry.retryTimer = setTimeout(() => {
            entry.retryTimer = null;
            if (this.threads.get(threadId) === entry) this.subscribeThread(threadId, entry);
          }, STREAM_RETRY_MS * 4);
        }
      },
    );
    entry.subscription = subscription;
  }

  private handleConnectionLost(reason: string): void {
    this.connection = null;
    this.shellSubscription = null;
    for (const entry of this.threads.values()) entry.subscription = null;
    if (!this.running) return;
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running) return;
    const delay = Math.round(this.reconnectDelayMs * (0.75 + Math.random() * 0.5));
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
    this.setPhase("retrying", reason);
    this.deps.log?.(`t3code: ${this.config.label}: ${reason} (retrying in ${delay}ms)`);
    const generation = this.generation;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation === this.generation && this.running) void this.connect();
    }, delay);
  }

  private teardownConnection(reason: string): void {
    const connection = this.connection;
    this.connection = null;
    this.shellSubscription = null;
    for (const entry of this.threads.values()) entry.subscription = null;
    connection?.close(reason);
  }

  private clearTimers(): void {
    for (const timer of [this.readyTimer, this.shellRetryTimer]) if (timer) clearTimeout(timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.readyTimer = null;
    this.shellRetryTimer = null;
    this.reconnectTimer = null;
    for (const entry of this.threads.values()) {
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
  }

  private setPhase(phase: EnvironmentPhase, status: string): void {
    if (this.phaseValue === phase && this.statusValue === status) return;
    this.phaseValue = phase;
    this.statusValue = status;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error);
}
