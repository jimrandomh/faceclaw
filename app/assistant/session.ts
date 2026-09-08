import { sendExtensionAssistant } from "../apps/external/extension-providers";
import {
  ASSISTANT_SYSTEM_PROMPT_BASE,
  buildAssistantSystemPrompt,
  describeAssistantContext,
} from "../prompts";
import { assistantBridge } from "./bridge-client";
import { DirectAssistantBackend } from "./direct-backend";
import type { LlmMessage, LlmToolDefinition } from "./llm-protocol";
import type { ResolvedAssistantModel } from "./models";
import { toolRegistry, type ToolRegistry } from "./tool-registry";
import type {
  AssistantBridgeConfig,
  AssistantContext,
  AssistantTurnCallbacks,
  AssistantTurnHandle,
} from "./types";

/**
 * One assistant conversation. Owns the message history and turn state and
 * drives either the on-phone provider loop (direct) or the external agent
 * bridge. The UI talks only to this surface, so AssistantLayer is
 * backend-agnostic.
 *
 * Sessions are cheap and idle-expire (see isExpired): the shell starts a fresh
 * one for a new wakeword and reuses the current one for a follow-up. In
 * external mode the conversation history lives on the agent's machine (one
 * long-lived session there), so expiry here only affects the overlay UI.
 */

/** Which engine answers utterances, plus what it needs to do so. */
export type AssistantBackendConfig =
  | { kind: "direct"; llm: ResolvedAssistantModel }
  | { kind: "external"; bridge: AssistantBridgeConfig }
  | { kind: "extension"; component: string; generation: number; fallback: AssistantBackendConfig | null };

/** A new PTT after this much idle starts a fresh conversation. */
const SESSION_IDLE_MS = 10 * 60 * 1000;

/** Trim history from the head once it grows past this many messages. */
const MAX_HISTORY_MESSAGES = 40;

export class AssistantSession {
  private readonly directBackend = new DirectAssistantBackend();
  private readonly messages: LlmMessage[] = [];
  private turnHandle: AssistantTurnHandle | null = null;
  private lastActivityMs = Date.now();
  // API-safe tool name -> canonical registry name. Provider APIs restrict tool
  // names, so dotted registry names are sanitized and mapped back on calls.
  private readonly toolNameMap = new Map<string, string>();

  constructor(
    private readonly config: AssistantBackendConfig,
    private readonly registry: ToolRegistry = toolRegistry,
  ) {}

  matchesConfiguration(config: AssistantBackendConfig): boolean {
    if (this.config.kind !== config.kind) return false;
    if (this.config.kind === "extension" && config.kind === "extension") return this.config.component === config.component && this.config.generation === config.generation;
    if (this.config.kind === "direct" && config.kind === "direct") {
      return (
        this.config.llm.provider === config.llm.provider &&
        this.config.llm.model === config.llm.model &&
        this.config.llm.apiKey === config.llm.apiKey
      );
    }
    if (this.config.kind === "external" && config.kind === "external") {
      return (
        this.config.bridge.host === config.bridge.host &&
        this.config.bridge.port === config.bridge.port &&
        this.config.bridge.token === config.bridge.token
      );
    }
    return false;
  }

  /** Whether this session has been idle long enough to retire. */
  isExpired(nowMs = Date.now()): boolean {
    return this.config.kind === "extension" || nowMs - this.lastActivityMs > SESSION_IDLE_MS;
  }

  isTurnActive(): boolean {
    return this.turnHandle !== null;
  }

  /** Begin a turn from a spoken utterance. Only one turn runs at a time. */
  sendUtterance(text: string, ctx: AssistantContext, callbacks: AssistantTurnCallbacks): void {
    if (this.turnHandle) {
      callbacks.onError("The assistant is still working on the previous request");
      return;
    }
    this.lastActivityMs = Date.now();

    const finish = () => {
      this.turnHandle = null;
      this.lastActivityMs = Date.now();
    };
    const wrappedCallbacks: AssistantTurnCallbacks = {
      onTextDelta: callbacks.onTextDelta,
      onToolActivity: callbacks.onToolActivity,
      onTurnDone: (result) => {
        finish();
        callbacks.onTurnDone(result);
      },
      onError: (message) => {
        finish();
        callbacks.onError(message);
      },
    };

    if (this.config.kind === "extension") {
      const fallbackConfig = this.config.fallback;
      this.turnHandle = sendExtensionAssistant(text, wrappedCallbacks, () => {
        if (!fallbackConfig) { wrappedCallbacks.onError("Assistant unavailable; no host fallback is configured"); return { cancel() {} }; }
        const fallback = new AssistantSession(fallbackConfig, this.registry); fallback.sendUtterance(text, ctx, wrappedCallbacks);
        return { cancel() { fallback.cancel(); } };
      });
      return;
    }
    if (this.config.kind === "external") {
      // History and the agent loop live on the agent's machine; the phone just
      // streams this turn. The overlay keeps its own display state.
      this.turnHandle = assistantBridge.sendUtterance(text, ctx, wrappedCallbacks);
      return;
    }

    const llm = this.config.llm;
    // Local provider: keep the system prompt (and thus the tool declarations
    // that follow it in the rendered prompt) byte-stable so the on-phone
    // model's KV prefix cache survives across turns; the volatile context
    // (time, foreground app, battery) rides along with the utterance instead.
    const isLocal = llm.provider === "local";
    this.messages.push({
      role: "user",
      content: isLocal ? `${text}\n\n(${describeAssistantContext(ctx)})` : text,
    });
    this.trimHistory();
    this.turnHandle = this.directBackend.runTurn({
      provider: llm.provider,
      apiKey: llm.apiKey,
      model: llm.model,
      effort: llm.effort,
      system: isLocal ? ASSISTANT_SYSTEM_PROMPT_BASE : buildAssistantSystemPrompt(ctx),
      messages: this.messages,
      buildTools: () => this.buildToolDefinitions(),
      registry: this.registry,
      resolveToolName: (apiName) => this.toolNameMap.get(apiName) ?? apiName,
      callbacks: wrappedCallbacks,
    });
  }

  cancel(): void {
    this.turnHandle?.cancel();
    this.turnHandle = null;
    this.lastActivityMs = Date.now();
  }

  private buildToolDefinitions(): LlmToolDefinition[] {
    this.toolNameMap.clear();
    return this.registry.listTools().map((spec) => {
      const apiName = this.toApiToolName(spec.name);
      this.toolNameMap.set(apiName, spec.name);
      return { name: apiName, description: spec.description, input_schema: spec.inputSchema };
    });
  }

  /** Convert a canonical registry name to a provider-legal tool name. */
  private toApiToolName(name: string): string {
    let base = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    // Disambiguate the rare case where two canonical names sanitize alike.
    if (this.toolNameMap.has(base)) {
      let i = 2;
      while (this.toolNameMap.has(`${base}_${i}`)) i++;
      base = `${base}_${i}`;
    }
    return base;
  }

  private trimHistory(): void {
    if (this.messages.length <= MAX_HISTORY_MESSAGES) return;
    // Drop whole messages from the head. A leading orphan tool_result (whose
    // tool_use we trimmed) would be rejected by the API, so skip past any
    // tool_result-only user message left at the front.
    const overflow = this.messages.length - MAX_HISTORY_MESSAGES;
    this.messages.splice(0, overflow);
    while (this.messages.length && startsWithToolResult(this.messages[0]!)) {
      this.messages.shift();
    }
  }
}

function startsWithToolResult(message: LlmMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content[0]!.type === "tool_result"
  );
}
