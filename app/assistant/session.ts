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
  /** The Hermes server-side session for this conversation (Hermes keeps the history). */
  hermesSessionId?: string;
};

/** Which engine answers utterances, plus what it needs to do so. */
export type AssistantBackendConfig =
  | { kind: "direct"; llm: ResolvedAssistantModel }
  | { kind: "external"; bridge: AssistantBridgeConfig };

/** Trim history from the head once it grows past this many messages. */
const MAX_HISTORY_MESSAGES = 40;

/** The longest tool name every provider accepts (OpenAI allows 64; Anthropic, 128). */
const MAX_API_TOOL_NAME_LENGTH = 64;
/** Characters of the sanitized name kept at the start when shortening it. */
const SHORTENED_TOOL_NAME_HEAD = 16;


/** Hermes brings its own persona and tools; it only needs to know where the reply is shown. */
const HERMES_SYSTEM_PROMPT =
  "The user is talking to you through smart glasses with a small text display. Reply briefly in plain text, without Markdown.";

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
  // Saved with the history: Faceclaw only sends Hermes the latest message, so a
  // restored conversation must keep addressing the same server-side session.
  private readonly hermesSessionId: string;

  constructor(
    private config: AssistantBackendConfig,
    private readonly registry: ToolRegistry = toolRegistry,
    history?: AssistantSessionHistory,
  ) {
    this.hermesSessionId = typeof history?.hermesSessionId === "string" && history.hermesSessionId
      ? history.hermesSessionId
      : `faceclaw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
    return { messages: this.messages, transcript: this.transcript, engine: this.engine(), hermesSessionId: this.hermesSessionId };
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
      baseUrl: llm.baseUrl,
      sessionId: this.hermesSessionId,
      system: llm.provider === "hermes" ? HERMES_SYSTEM_PROMPT
        : isLocal ? ASSISTANT_SYSTEM_PROMPT_BASE : buildAssistantSystemPrompt(ctx),
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
    if (base.length > MAX_API_TOOL_NAME_LENGTH) {
      // Keep the start (the namespace) and the end (the tool's own name). The
      // hash of the whole name keeps shortened names distinct and stable.
      const hash = fnv32(name).toString(16).padStart(8, "0");
      const tail = MAX_API_TOOL_NAME_LENGTH - SHORTENED_TOOL_NAME_HEAD - hash.length - 2;
      base = `${base.slice(0, SHORTENED_TOOL_NAME_HEAD)}_${hash}_${base.slice(-tail)}`;
    }
    // Disambiguate the rare case where two canonical names sanitize alike.
    let apiName = base;
    for (let i = 2; this.toolNameMap.has(apiName); i++) {
      const suffix = `_${i}`;
      apiName = base.slice(0, MAX_API_TOOL_NAME_LENGTH - suffix.length) + suffix;
    }
    return apiName;
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

/** FNV-1a over UTF-16 code units: a small stable hash for shortened tool names. */
function fnv32(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
