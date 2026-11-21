import { openSocket, type SocketConnection } from "../native/socket";
import { AssistantMcpServer } from "./mcp-server";
import { toolRegistry } from "./tool-registry";
import type { AssistantContext, AssistantTurnCallbacks, AssistantTurnHandle } from "./types";

/**
 * Dial-out websocket client for the external assistant bridge (an OpenClaw
 * plugin or compatible server on the user's machine; see
 * notes/voice-assistant-design.md "External mode"). One JSON object per text
 * frame, three multiplexed channels:
 *
 *   ctl:  hello/hello-ack auth handshake, ping/pong, error
 *   chat: utterance in, streamed reply out (per-turn)
 *   mcp:  raw MCP JSON-RPC; the phone is the MCP *server* (ToolRegistry)
 *
 * Unlike G2MirrorClient (per-terminal-window, no reconnect), this connection
 * is a long-lived shell service: it stays up while configured so the remote
 * agent can make proactive tool calls, and it re-dials with backoff.
 */

const PROTOCOL_VERSION = 1;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
/** Backstop on a turn the bridge never finishes (server-side cap is 2 min). */
const TURN_TIMEOUT_MS = 3 * 60 * 1000;
/**
 * iOS only: how often to ping an open connection. The bridge sends nothing
 * between turns, and iOS's URLSession fails a websocket that has received
 * nothing for its request timeout (20 s, FaceclawSocket.m); the bridge's pong
 * is that traffic. Android's socket pings by itself (okhttp pingInterval).
 */
const IOS_KEEPALIVE_MS = 12_000;

export type AssistantBridgePhase = "idle" | "connecting" | "connected" | "failed";

export type AssistantBridgeState = {
  phase: AssistantBridgePhase;
  status: string;
};

/**
 * Where a Bridge host setting dials: a bare host or IP address means plain
 * ws:// on the Bridge port; a full ws:// or wss:// address is used as written
 * (wss for a bridge behind a TLS proxy, which iOS's App Transport Security
 * requires for most addresses).
 */
export function assistantBridgeUrl(host: string, port: number): string {
  return /^wss?:\/\//i.test(host) ? host : `ws://${host}:${port}`;
}

export type AssistantBridgeOptions = {
  /** A host name or IP address, or a full ws:// or wss:// address (see assistantBridgeUrl). */
  host: string;
  /** Used with a bare host only. */
  port: number;
  token: string;
  deviceName: string;
  /** Reads assistant.allowProactive; consulted per proactive tool call. */
  allowProactive: () => boolean;
};

type ActiveTurn = {
  turnId: string;
  callbacks: AssistantTurnCallbacks;
  textSoFar: string;
  timer: ReturnType<typeof setTimeout>;
};

export class AssistantBridgeClient {
  private options: AssistantBridgeOptions | null = null;
  private ws: SocketConnection | null = null;
  /** Counts connections, so a superseded socket's late callbacks are ignored. */
  private connectionSeq = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private phase: AssistantBridgePhase = "idle";
  private status = "Not configured.";
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private activeTurn: ActiveTurn | null = null;
  private turnSeq = 0;
  private mcpServer: AssistantMcpServer | null = null;
  private unsubscribeToolsChanged: (() => void) | null = null;
  private readonly stateListeners = new Set<(state: AssistantBridgeState) => void>();

  state(): AssistantBridgeState {
    return { phase: this.phase, status: this.status };
  }

  onStateChange(listener: (state: AssistantBridgeState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  isConnected(): boolean {
    return this.phase === "connected";
  }

  /**
   * Set (or replace) the bridge configuration and connect. Safe to call again
   * with new settings; the old connection is torn down first.
   */
  configure(options: AssistantBridgeOptions): void {
    this.stop();
    this.options = options;
    this.stopped = false;
    this.mcpServer = new AssistantMcpServer({
      send: (msg) => this.send({ chan: "mcp", msg }),
      isTurnActive: () => this.activeTurn !== null,
      allowProactive: options.allowProactive,
    });
    this.unsubscribeToolsChanged = toolRegistry.onToolsChanged(() => {
      if (this.phase === "connected") this.mcpServer?.sendToolsChanged();
    });
    this.connect();
  }

  /** Disconnect and stay down until the next configure(). */
  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.failActiveTurn("Bridge connection closed");
    if (this.unsubscribeToolsChanged) {
      this.unsubscribeToolsChanged();
      this.unsubscribeToolsChanged = null;
    }
    this.mcpServer = null;
    ++this.connectionSeq;
    this.clearKeepalive();
    if (this.ws) {
      try {
        this.ws.close(1000, "bye");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.setState("idle", "Not connected.");
  }

  /**
   * Send an utterance as a new turn. Streaming replies arrive via callbacks.
   * A turn already in flight is superseded (the session serializes turns, so
   * this is just a safety net).
   */
  sendUtterance(
    text: string,
    ctx: AssistantContext,
    callbacks: AssistantTurnCallbacks,
  ): AssistantTurnHandle {
    if (this.phase !== "connected") {
      callbacks.onError(`Agent bridge is not connected (${this.status})`);
      return { cancel: () => {} };
    }
    this.failActiveTurn("Superseded by a new request");
    const turnId = `t${++this.turnSeq}`;
    this.activeTurn = {
      turnId,
      callbacks,
      textSoFar: "",
      timer: setTimeout(() => {
        if (this.activeTurn?.turnId !== turnId) return;
        this.failActiveTurn("The agent took too long to reply");
      }, TURN_TIMEOUT_MS),
    };
    this.send({ chan: "chat", type: "utterance", turnId, text, ctx });
    return {
      cancel: () => {
        if (this.activeTurn?.turnId !== turnId) return;
        this.send({ chan: "chat", type: "cancel", turnId });
        this.clearActiveTurn();
      },
    };
  }

  private connect(): void {
    if (this.stopped || this.ws || !this.options) return;
    const { host, port } = this.options;
    const url = assistantBridgeUrl(host, port);
    this.setState("connecting", `Connecting to ${url === host ? url : `${host}:${port}`}...`);
    const connection = ++this.connectionSeq;
    const current = () => !this.stopped && connection === this.connectionSeq;
    try {
      this.ws = openSocket(url, {
        onOpen: () => {
          if (!current()) return;
          this.setState("connecting", "Authenticating...");
          this.send({
            chan: "ctl",
            type: "hello",
            version: PROTOCOL_VERSION,
            token: this.options!.token,
            deviceName: this.options!.deviceName,
            capabilities: ["chat", "mcp"],
          });
          this.startKeepalive();
        },
        onTextMessage: (message: string) => {
          if (!current()) return;
          this.handleMessage(String(message));
        },
        onClosed: (code: number, reason: string) => {
          if (!current()) return;
          this.handleConnectionLost(
            `Connection closed (${Number(code)}${reason ? `: ${String(reason)}` : ""})`,
          );
        },
        onFailure: (message: string) => {
          if (!current()) return;
          this.handleConnectionLost(`Connection failed: ${String(message)}`);
        },
      });
    } catch (error) {
      this.ws = null;
      this.handleConnectionLost(
        `Connection failed: ${String((error as Error)?.message ?? error)}`,
      );
    }
  }

  private handleMessage(raw: string): void {
    let frame: any = null;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    switch (frame.chan) {
      case "ctl":
        this.handleCtl(frame);
        return;
      case "chat":
        this.handleChat(frame);
        return;
      case "mcp":
        this.mcpServer?.handleMessage(frame.msg);
        return;
      default:
        return;
    }
  }

  private handleCtl(frame: any): void {
    if (frame.type === "hello-ack") {
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      this.setState("connected", `Connected to ${String(frame.serverName ?? "bridge")}`);
      return;
    }
    if (frame.type === "ping") {
      this.send({ chan: "ctl", type: "pong", ts: frame.ts });
      return;
    }
    if (frame.type === "error") {
      // The server closes after a ctl error; the close handler schedules the
      // re-dial. Record the reason so the status is more useful than a bare
      // close code (especially for a bad token).
      this.status = `Bridge error: ${String(frame.message ?? "unknown")}`;
      return;
    }
  }

  private handleChat(frame: any): void {
    const turn = this.activeTurn;
    if (!turn || frame.turnId !== turn.turnId) return;
    switch (frame.type) {
      case "text-delta": {
        const text = typeof frame.text === "string" ? frame.text : "";
        turn.textSoFar = frame.replace === true ? text : turn.textSoFar + text;
        turn.callbacks.onTextDelta(text, turn.textSoFar);
        return;
      }
      case "tool-activity":
        turn.callbacks.onToolActivity(String(frame.label ?? "tool"));
        return;
      case "turn-done": {
        this.clearActiveTurn();
        turn.callbacks.onTurnDone({
          stopReason: typeof frame.stopReason === "string" ? frame.stopReason : null,
        });
        return;
      }
      case "turn-error":
        this.clearActiveTurn();
        turn.callbacks.onError(String(frame.message ?? "Agent error"));
        return;
      default:
        return;
    }
  }

  private handleConnectionLost(status: string): void {
    // A failure can be followed by a close for the same socket; count only one.
    ++this.connectionSeq;
    this.ws = null;
    this.clearKeepalive();
    // Keep a ctl-error status (e.g. "invalid token") in preference to the
    // generic close message that follows it.
    const detail = this.status.startsWith("Bridge error:") ? this.status : status;
    this.failActiveTurn("Bridge connection lost");
    this.setState("failed", detail);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startKeepalive(): void {
    this.clearKeepalive();
    if (!global.isIOS) return;
    this.keepaliveTimer = setInterval(() => this.send({ chan: "ctl", type: "ping", ts: Date.now() }), IOS_KEEPALIVE_MS);
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer === null) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearActiveTurn(): void {
    if (!this.activeTurn) return;
    clearTimeout(this.activeTurn.timer);
    this.activeTurn = null;
  }

  private failActiveTurn(message: string): void {
    const turn = this.activeTurn;
    if (!turn) return;
    this.clearActiveTurn();
    turn.callbacks.onError(message);
  }

  private send(frame: object): void {
    if (!this.ws) return;
    try {
      this.ws.sendText(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    } catch {
      // A send on a dying socket; the close/failure callback handles recovery.
    }
  }

  private setState(phase: AssistantBridgePhase, status: string): void {
    this.phase = phase;
    this.status = status;
    const state = this.state();
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // listeners must not break the client
      }
    }
  }
}

/** Process-wide bridge client (main isolate), configured by the dashboard controller. */
export const assistantBridge = new AssistantBridgeClient();
