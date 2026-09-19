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

/** One shared conversation, independent of the voice overlay or chat window. */
export type AssistantTranscriptEntry = { role: "user" | "assistant"; text: string };
export type AssistantSessionHistory = {
  messages: LlmMessage[];
  transcript: AssistantTranscriptEntry[];
  /** Model identity for safe replay after Auto resolves differently on restart. */
  engine?: string;
};

/** Which engine answers utterances, plus what it needs to do so. */
export type AssistantBackendConfig =
  | { kind: "direct"; llm: ResolvedAssistantModel }
  | { kind: "external"; bridge: AssistantBridgeConfig };

/** Trim history from the head once it grows past this many messages. */
const MAX_HISTORY_MESSAGES = 40;

export class AssistantSession {
  private readonly directBackend = new DirectAssistantBackend();
  private readonly messages: LlmMessage[] = [];
  private turnHandle: AssistantTurnHandle | null = null;
  readonly transcript: AssistantTranscriptEntry[] = [];
  status = "";
  private readonly listeners = new Set<() => void>();
  private turnGeneration = 0;
  // API-safe tool name -> canonical registry name. Provider APIs restrict tool
  // names, so dotted registry names are sanitized and mapped back on calls.
  private readonly toolNameMap = new Map<string, string>();

  constructor(
    private config: AssistantBackendConfig,
    private readonly registry: ToolRegistry = toolRegistry,
    history?: AssistantSessionHistory,
  ) {
    if (history) {
      this.messages.push(...history.messages);
      this.transcript.push(...history.transcript);
      if (history.engine !== this.engine()) this.rebuildTextHistory();
    }
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.warn("assistant history listener failed", error); }
    }
  }

  history(): AssistantSessionHistory {
    return { messages: this.messages, transcript: this.transcript, engine: this.engine() };
  }

  configure(config: AssistantBackendConfig): void {
    if (this.isTurnActive()) return;
    // Opaque reasoning/tool provider items are only replayable on their
    // original model. Preserve visible conversation when switching engines.
    if (this.config.kind !== config.kind ||
        (this.config.kind === "direct" && config.kind === "direct" &&
         (this.config.llm.model !== config.llm.model || this.config.llm.provider !== config.llm.provider))) {
      this.rebuildTextHistory();
    }
    this.config = config;
  }

  private engine(): string {
    return this.config.kind === "direct" ? `${this.config.llm.provider}:${this.config.llm.model}` : "external";
  }

  private rebuildTextHistory(): void {
    this.messages.splice(0, this.messages.length, ...this.transcript
      .filter((entry) => entry.text.trim())
      .map((entry) => ({ role: entry.role, content: entry.text })));
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
    text = text.trim();
    if (!text) return;
    const generation = ++this.turnGeneration;
    const reply: AssistantTranscriptEntry = { role: "assistant", text: "" };
    this.transcript.push({ role: "user", text }, reply);
    this.status = "Thinking...";
    // Install a sentinel before calling providers: some failures are synchronous.
    this.turnHandle = { cancel: () => {} };
    this.changed();

    const finish = () => {
      ++this.turnGeneration;
      this.turnHandle = null;
      this.changed();
    };
    const wrappedCallbacks: AssistantTurnCallbacks = {
      onTextDelta: (delta, full) => {
        if (generation !== this.turnGeneration) return;
        reply.text = full;
        this.status = "Thinking...";
        this.changed();
        callbacks.onTextDelta(delta, full);
      },
      onToolActivity: (label) => {
        if (generation !== this.turnGeneration) return;
        this.status = `→ ${label}`;
        this.changed();
        callbacks.onToolActivity(label);
      },
      onTurnDone: (result) => {
        if (generation !== this.turnGeneration) return;
        this.status = "";
        finish();
        callbacks.onTurnDone(result);
      },
      onError: (message) => {
        if (generation !== this.turnGeneration) return;
        this.status = message;
        finish();
        callbacks.onError(message);
      },
    };

    if (this.config.kind === "external") {
      // History and the agent loop live on the agent's machine; the phone just
      // streams this turn. The overlay keeps its own display state.
      const handle = assistantBridge.sendUtterance(text, ctx, wrappedCallbacks);
      if (generation === this.turnGeneration && this.turnHandle) this.turnHandle = handle;
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
    // Work on a turn-local array: cancelled tools may finish later, and must
    // never append orphan results into a subsequent turn's context.
    const turnMessages = this.messages.slice();
    const handle = this.directBackend.runTurn({
      provider: llm.provider,
      apiKey: llm.apiKey,
      model: llm.model,
      effort: llm.effort,
      system: isLocal ? ASSISTANT_SYSTEM_PROMPT_BASE : buildAssistantSystemPrompt(ctx),
      messages: turnMessages,
      buildTools: () => this.buildToolDefinitions(),
      registry: this.registry,
      resolveToolName: (apiName) => this.toolNameMap.get(apiName) ?? apiName,
      callbacks: {
        ...wrappedCallbacks,
        onTurnDone: (result) => {
          if (generation !== this.turnGeneration) return;
          this.messages.splice(0, this.messages.length, ...turnMessages);
          wrappedCallbacks.onTurnDone(result);
        },
        onError: (message) => {
          if (generation !== this.turnGeneration) return;
          // Retain the visible partial answer, without incomplete tool pairs.
          if (reply.text) this.messages.push({ role: "assistant", content: reply.text });
          wrappedCallbacks.onError(message);
        },
      },
    });
    if (generation === this.turnGeneration && this.turnHandle) this.turnHandle = handle;
  }

  cancel(): void {
    if (!this.turnHandle) return;
    ++this.turnGeneration;
    this.turnHandle.cancel();
    this.turnHandle = null;
    const reply = this.transcript[this.transcript.length - 1];
    if (reply?.role === "assistant" && reply.text) {
      this.messages.push({ role: "assistant", content: reply.text });
    }
    this.status = "Cancelled";
    this.changed();
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
