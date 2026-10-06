/**
 * Minimal client for T3 Code's WebSocket RPC (Effect RPC, JSON
 * serialization), without the Effect library. One instance owns one socket;
 * reconnecting means making a new instance (the caller owns retry policy).
 *
 * Wire format (one JSON message per text frame; the server also accepts an
 * array of messages in one frame):
 *   -> {"_tag":"Request","id":N,"tag":"<method>","payload":{...},"headers":[]}
 *   -> {"_tag":"Ack","requestId":N}        after EVERY Chunk, or the stream stalls
 *   -> {"_tag":"Interrupt","requestId":N}  cancel a call or subscription
 *   -> {"_tag":"Ping"}                     keepalive; the server only answers
 *   <- {"_tag":"Chunk","requestId":N,"values":[...]}
 *   <- {"_tag":"Exit","requestId":N,"exit":{"_tag":"Success","value":...}}
 *   <- {"_tag":"Exit","requestId":N,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":...}|{"_tag":"Die","defect":...}|{"_tag":"Interrupt"}]}}
 *   <- {"_tag":"Defect","defect":...}      connection-level; fails every pending call
 *   <- {"_tag":"Pong"}
 *
 * The server never pings and has no idle timeout, so dead sockets are found
 * the way T3's own client finds them: a Ping every 5s, and three unanswered
 * in a row close the connection.
 */

export type RpcSocketHandlers = {
  onOpen(): void;
  onMessage(text: string): void;
  /** The socket closed or failed; called at most once. */
  onClose(reason: string): void;
};

export type RpcSocket = {
  send(text: string): void;
  close(): void;
};

export type RpcSocketFactory = (url: string, handlers: RpcSocketHandlers) => RpcSocket;

export type T3RpcErrorKind =
  /** A typed failure from the handler (error carries its `_tag`). */
  | "fail"
  /** A defect: unknown method, payload decode failure, handler crash. */
  | "die"
  /** The call or subscription was interrupted (by us or the server). */
  | "interrupt"
  /** The socket closed (or never opened) before the call finished. */
  | "disconnected";

export class T3RpcError extends Error {
  constructor(
    readonly kind: T3RpcErrorKind,
    message: string,
    /** For "fail": the typed error object as sent (has a `_tag`). */
    readonly error: unknown = null,
  ) {
    super(message);
    this.name = "T3RpcError";
  }

  /** The typed error's `_tag` (e.g. "EnvironmentAuthorizationError"), for "fail" errors. */
  get errorTag(): string | null {
    const tag = (this.error as { _tag?: unknown } | null)?._tag;
    return typeof tag === "string" ? tag : null;
  }
}

export type T3RpcState = "connecting" | "open" | "closed";

export type T3RpcOptions = {
  url: string;
  openSocket: RpcSocketFactory;
  pingIntervalMs?: number;
  maxMissedPongs?: number;
  /** Close the attempt if the socket hasn't opened by then. */
  openTimeoutMs?: number;
};

export type T3Subscription = {
  /** Interrupt the stream server-side and stop delivering values. */
  cancel(): void;
};

type PendingCall = {
  kind: "call";
  resolve: (value: unknown) => void;
  reject: (error: T3RpcError) => void;
};

type PendingStream = {
  kind: "stream";
  onValues: (values: unknown[]) => void;
  /** Called once: null for a successful end, else why it stopped. */
  onEnd: (error: T3RpcError | null) => void;
};

const DEFAULT_PING_INTERVAL_MS = 5_000;
const DEFAULT_MAX_MISSED_PONGS = 3;
const DEFAULT_OPEN_TIMEOUT_MS = 15_000;

export class T3RpcConnection {
  private readonly socket: RpcSocket;
  private state: T3RpcState = "connecting";
  private closeReason = "";
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall | PendingStream>();
  private readonly stateListeners = new Set<(state: T3RpcState, reason: string) => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private missedPongs = 0;
  /** Frames sent while still connecting, flushed on open. */
  private outbox: string[] = [];

  constructor(private readonly options: T3RpcOptions) {
    this.openTimer = setTimeout(() => this.shutdown("Timed out connecting."), options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
    this.socket = options.openSocket(options.url, {
      onOpen: () => this.handleOpen(),
      onMessage: (text) => this.handleFrame(text),
      onClose: (reason) => this.shutdown(reason || "Connection closed."),
    });
  }

  getState(): T3RpcState {
    return this.state;
  }

  /** Why the connection closed ("" while connecting or open). */
  getCloseReason(): string {
    return this.closeReason;
  }

  onStateChange(listener: (state: T3RpcState, reason: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** A unary call; rejects with T3RpcError. Calls made while connecting go out once the socket opens. */
  call<T = unknown>(tag: string, payload: unknown = {}): Promise<T> {
    if (this.state === "closed") {
      return Promise.reject(new T3RpcError("disconnected", this.closeReason || "Not connected."));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { kind: "call", resolve: resolve as (value: unknown) => void, reject });
      this.send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  /**
   * A streaming subscription. Every chunk is acked as soon as it is
   * delivered. onEnd fires exactly once (unless cancel() comes first): null
   * when the stream completed, else the error that stopped it (including
   * "disconnected" when the socket drops).
   */
  subscribe(
    tag: string,
    payload: unknown,
    onValues: (values: unknown[]) => void,
    onEnd: (error: T3RpcError | null) => void,
  ): T3Subscription {
    if (this.state === "closed") {
      const error = new T3RpcError("disconnected", this.closeReason || "Not connected.");
      setTimeout(() => onEnd(error), 0);
      return { cancel: () => {} };
    }
    const id = this.nextId++;
    this.pending.set(id, { kind: "stream", onValues, onEnd });
    this.send({ _tag: "Request", id, tag, payload, headers: [] });
    return {
      cancel: () => {
        if (!this.pending.delete(id)) return;
        if (this.state !== "closed") this.send({ _tag: "Interrupt", requestId: id });
      },
    };
  }

  /** Close the socket; pending calls fail as "disconnected". */
  close(reason = "Closed."): void {
    this.shutdown(reason);
  }

  private handleOpen(): void {
    if (this.state !== "connecting") return;
    this.clearOpenTimer();
    this.state = "open";
    this.missedPongs = 0;
    this.pingTimer = setInterval(() => this.ping(), this.options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
    const queued = this.outbox;
    this.outbox = [];
    for (const text of queued) this.sendText(text);
    this.emitState();
  }

  private ping(): void {
    if (this.state !== "open") return;
    if (this.missedPongs >= (this.options.maxMissedPongs ?? DEFAULT_MAX_MISSED_PONGS)) {
      this.shutdown("Server stopped responding.");
      return;
    }
    this.missedPongs++;
    this.send({ _tag: "Ping" });
  }

  private handleFrame(text: string): void {
    if (this.state === "closed") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      // A handler may have closed the connection mid-batch.
      if (this.getState() === "closed") return;
      this.handleMessage(message as Record<string, unknown>);
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    // Any traffic proves the socket is alive.
    this.missedPongs = 0;
    switch (message?._tag) {
      case "Pong":
        return;
      case "Chunk": {
        const requestId = message.requestId as number;
        const entry = this.pending.get(requestId);
        // Ack even for a stream we've cancelled: the server blocks the
        // stream on it until the interrupt lands.
        this.send({ _tag: "Ack", requestId });
        if (entry?.kind !== "stream") return;
        const values = Array.isArray(message.values) ? (message.values as unknown[]) : [];
        try {
          entry.onValues(values);
        } catch (error) {
          // (console via globalThis: this file also builds for Node tests without DOM typings.)
          (globalThis as { console?: { error(message: string): void } }).console?.error(`t3 rpc: stream handler failed: ${error}`);
        }
        return;
      }
      case "Exit": {
        const requestId = message.requestId as number;
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        const exit = message.exit as { _tag?: string; value?: unknown; cause?: unknown } | undefined;
        const error = exit?._tag === "Success" ? null : causeToError(exit?.cause);
        if (entry.kind === "call") {
          if (error) entry.reject(error);
          else entry.resolve(exit?.value ?? null);
        } else {
          entry.onEnd(error);
        }
        return;
      }
      case "Defect":
        this.failAll(new T3RpcError("die", `Server defect: ${describeDefect(message.defect)}`));
        return;
      default:
        return;
    }
  }

  private send(message: unknown): void {
    if (this.state === "closed") return;
    const text = JSON.stringify(message);
    if (this.state === "connecting") this.outbox.push(text);
    else this.sendText(text);
  }

  private sendText(text: string): void {
    try {
      this.socket.send(text);
    } catch (error) {
      this.shutdown(`Send failed: ${error}`);
    }
  }

  private failAll(error: T3RpcError): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.kind === "call") entry.reject(error);
      else entry.onEnd(error);
    }
  }

  private shutdown(reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.closeReason = reason;
    this.outbox = [];
    this.clearOpenTimer();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
    this.failAll(new T3RpcError("disconnected", reason));
    this.emitState();
  }

  private clearOpenTimer(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
  }

  private emitState(): void {
    for (const listener of [...this.stateListeners]) listener(this.state, this.closeReason);
  }
}

/** Map an Exit failure cause (array of Fail/Die/Interrupt reasons) to one error, preferring typed failures. */
export function causeToError(cause: unknown): T3RpcError {
  const reasons = Array.isArray(cause) ? (cause as Array<Record<string, unknown>>) : [];
  const fail = reasons.find((reason) => reason?._tag === "Fail");
  if (fail) return new T3RpcError("fail", describeTypedError(fail.error), fail.error);
  const die = reasons.find((reason) => reason?._tag === "Die");
  if (die) return new T3RpcError("die", describeDefect(die.defect));
  if (reasons.some((reason) => reason?._tag === "Interrupt")) return new T3RpcError("interrupt", "Interrupted.");
  return new T3RpcError("die", "Request failed.");
}

function describeTypedError(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message) return record.message;
    if (typeof record.detail === "string" && record.detail) return record.detail;
    if (typeof record._tag === "string") return record._tag;
  }
  return String(error);
}

function describeDefect(defect: unknown): string {
  if (typeof defect === "string") return defect.split("\n")[0]!;
  if (defect && typeof defect === "object") {
    const record = defect as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
  }
  return String(defect);
}
