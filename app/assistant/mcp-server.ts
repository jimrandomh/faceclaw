import { toolRegistry, type ToolRegistry } from "./tool-registry";
import { FACECLAW_VERSION } from "../version";

/**
 * Minimal MCP (Model Context Protocol) server surface over the assistant
 * bridge's `mcp` channel. The phone serves its ToolRegistry to the external
 * agent: `tools/list`, `tools/call`, and `notifications/tools/list_changed`
 * (emitted by the bridge client when the registry changes).
 *
 * Transport-agnostic: the bridge client hands decoded JSON-RPC messages to
 * handleMessage and provides `send` to deliver replies/notifications.
 */

const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Proactive display actions are rate-limited to this many per minute. */
const PROACTIVE_CALLS_PER_MINUTE = 6;

export type McpServerOptions = {
  send: (msg: object) => void;
  /** Whether a voice turn is currently in flight (calls outside one are "proactive"). */
  isTurnActive: () => boolean;
  /** Master setting gate for proactive calls (assistant.allowProactive). */
  allowProactive: () => boolean;
  registry?: ToolRegistry;
};

export class AssistantMcpServer {
  private readonly registry: ToolRegistry;
  private readonly proactiveCallTimes: number[] = [];

  constructor(private readonly options: McpServerOptions) {
    this.registry = options.registry ?? toolRegistry;
  }

  /** Notify the agent that the live tool set changed. */
  sendToolsChanged(): void {
    this.options.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  handleMessage(msg: any): void {
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (typeof msg.method !== "string") return; // responses to server-sent requests: none yet
    const id = msg.id;
    const isNotification = id === undefined || id === null;

    switch (msg.method) {
      case "initialize":
        this.reply(id, {
          protocolVersion:
            typeof msg.params?.protocolVersion === "string"
              ? msg.params.protocolVersion
              : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "faceclaw", version: FACECLAW_VERSION },
        });
        return;
      case "notifications/initialized":
        return;
      case "ping":
        this.reply(id, {});
        return;
      case "tools/list":
        this.reply(id, {
          tools: this.registry.listTools().map((spec) => ({
            name: spec.name,
            description: spec.description,
            inputSchema: spec.inputSchema,
          })),
        });
        return;
      case "tools/call":
        void this.handleToolCall(id, msg.params);
        return;
      default:
        if (!isNotification) {
          this.options.send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not supported: ${msg.method}` },
          });
        }
        return;
    }
  }

  private async handleToolCall(id: unknown, params: any): Promise<void> {
    const name = typeof params?.name === "string" ? params.name : "";
    const args = params?.arguments ?? {};
    // A call while no voice turn is in flight is a proactive action by the
    // remote agent; the phone (never the bridge) enforces the gating.
    const proactive = !this.options.isTurnActive();
    if (proactive && !this.options.allowProactive()) {
      this.replyToolError(id, "Proactive assistant actions are disabled in Settings");
      return;
    }
    if (proactive && !this.admitProactiveCall()) {
      this.replyToolError(id, "Proactive action rate limit exceeded; try again later");
      return;
    }
    const result = await this.registry.callTool(name, args, { proactive });
    this.reply(id, {
      content: [{ type: "text", text: result.ok ? result.content ?? "" : result.error ?? "Tool error" }],
      isError: !result.ok,
    });
  }

  /** Sliding-window rate limiter for proactive calls. */
  private admitProactiveCall(): boolean {
    const now = Date.now();
    while (this.proactiveCallTimes.length && now - this.proactiveCallTimes[0]! > 60_000) {
      this.proactiveCallTimes.shift();
    }
    if (this.proactiveCallTimes.length >= PROACTIVE_CALLS_PER_MINUTE) return false;
    this.proactiveCallTimes.push(now);
    return true;
  }

  private reply(id: unknown, result: object): void {
    if (id === undefined || id === null) return;
    this.options.send({ jsonrpc: "2.0", id, result });
  }

  private replyToolError(id: unknown, text: string): void {
    this.reply(id, { content: [{ type: "text", text }], isError: true });
  }
}
