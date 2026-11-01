import type {
  LlmContentBlock,
  LlmMessage,
  LlmStreamHandle,
  LlmStreamOptions,
} from "../assistant/llm-protocol";
import type { LocalModelState } from "./local-llm-types";
export type { LocalModelState } from "./local-llm-types";

declare const FaceclawSystemLanguageModel: any;

/**
 * The on-phone LLM on iOS: Apple's Foundation Models system model (Apple
 * Intelligence, iOS 26+), through FaceclawSystemLanguageModel.swift. Same
 * surface as Android's local-llm.ts, so the direct assistant loop, Translate,
 * Calculator and the Microphones helpers treat it as the "local" provider.
 *
 * Why not Android's Qwen3-4B on llama.cpp: iOS forbids GPU work in the
 * background (where Faceclaw usually is, driving the glasses with the phone
 * locked), CPU-only inference of a 4B model is far too slow on a phone, and a
 * ~3 GB in-process model makes the app the first thing jetsam kills. The
 * system model runs out of process on the Neural Engine, needs no download,
 * and decodes tool arguments under a schema constraint (like our GBNF grammar
 * on Android). Its costs: a 4096-token context (the Swift side fits history
 * and tool definitions into it), Apple's guardrails, a background request
 * budget, and Apple Intelligence-capable hardware.
 *
 * Tool calls: the framework runs tools itself, mid-response. The Swift side
 * parks each call and reports it; here that ends the loop iteration with
 * stopReason "tool_use", the direct backend executes the tools as for any
 * provider, and its next request (ending in the matching tool_result blocks)
 * resumes the parked generation instead of starting a new one.
 */

export const LOCAL_MODEL = {
  id: "apple-foundation-model",
  label: "Apple Intelligence",
  sizeBytes: 0,
};

const DEFAULT_MAX_TOKENS = 512;
/** A generation parked in a tool call is abandoned if the tool loop never returns. */
const PARKED_TIMEOUT_MS = 3 * 60 * 1000;
/**
 * Only used when tool results arrive with no parked generation to resume (it
 * timed out, or the app restarted mid-turn): the framework has no way to
 * continue after a tool output without a new prompt.
 */
export const CONTINUE_PROMPT = "Use the tool results above to finish answering my last request.";

type Availability =
  | "available"
  | "unsupportedOS"
  | "deviceNotEligible"
  | "appleIntelligenceNotEnabled"
  | "modelNotReady"
  | "unavailable";

const UNAVAILABLE_DETAIL: Record<Exclude<Availability, "available">, string> = {
  unsupportedOS: "needs iOS 26",
  deviceNotEligible: "not on this iPhone",
  appleIntelligenceNotEnabled: "Apple Intelligence off",
  modelNotReady: "downloading",
  unavailable: "unavailable",
};

const UNAVAILABLE_MESSAGE: Record<Exclude<Availability, "available">, string> = {
  unsupportedOS: "The on-phone model needs iOS 26 or later with Apple Intelligence.",
  deviceNotEligible: "This iPhone doesn't support Apple Intelligence, which the on-phone model uses.",
  appleIntelligenceNotEnabled:
    "Turn on Apple Intelligence (iOS Settings > Apple Intelligence & Siri) to use the on-phone model.",
  modelNotReady: "Apple Intelligence is still downloading its model. Try again later.",
  unavailable: "Apple Intelligence's on-device model is unavailable right now.",
};

export function localModelAvailability(): Availability {
  try {
    if (typeof FaceclawSystemLanguageModel === "undefined") return "unsupportedOS";
    const value = String(FaceclawSystemLanguageModel.availability());
    return value in UNAVAILABLE_MESSAGE || value === "available" ? (value as Availability) : "unavailable";
  } catch {
    return "unsupportedOS";
  }
}

/** Whether this iPhone can ever run the model (Apple Intelligence may still be off or downloading). */
export function isLocalModelSupported(): boolean {
  const availability = localModelAvailability();
  return availability !== "unsupportedOS" && availability !== "deviceNotEligible";
}

export function isLocalModelReady(): boolean {
  return localModelAvailability() === "available";
}

export function localModelState(): LocalModelState {
  const availability = localModelAvailability();
  if (availability === "available") return { status: "ready", bytesDownloaded: 0, totalBytes: 0 };
  return { status: "unavailable", bytesDownloaded: 0, totalBytes: 0, detail: UNAVAILABLE_DETAIL[availability] };
}

/** The user-facing reason the model can't run, or "" when it can. */
export function localModelUnavailableMessage(): string {
  const availability = localModelAvailability();
  return availability === "available" ? "" : UNAVAILABLE_MESSAGE[availability];
}

// iOS manages the system model itself: there is nothing to download, cancel,
// delete or unload, and no progress to watch.
export function onLocalModelStateChanged(_listener: (state: LocalModelState) => void): () => void {
  return () => {};
}
export function startLocalModelDownload(): void {}
export function cancelLocalModelDownload(): void {}
export function deleteLocalModel(): void {}
export function unloadLocalModel(): void {}

type HistoryEntry =
  | { type: "prompt" | "response"; text: string }
  | { type: "toolCalls"; calls: Array<{ id: string; name: string; arguments: string }> }
  | { type: "toolOutput"; id: string; name: string; text: string };

export type SystemModelRequest = {
  system: string;
  tools: Array<{ name: string; description: string; parameters: object }>;
  history: HistoryEntry[];
  prompt: string;
  maxTokens: number;
  permissive: boolean;
};

type ToolResultBlock = Extract<LlmContentBlock, { type: "tool_result" }>;

/**
 * Translate provider-neutral history into the Swift request: everything but
 * the newest user prompt becomes Transcript entries, and that prompt is what
 * the model answers.
 */
export function buildSystemModelRequest(
  options: Pick<LlmStreamOptions, "system" | "messages" | "tools" | "maxTokens">,
): SystemModelRequest {
  const messages = options.messages;
  const last = messages[messages.length - 1];
  const endsWithPrompt = last?.role === "user" && !toolResultsOf(last).length;
  const history: HistoryEntry[] = [];
  const toolNames = new Map<string, string>();
  for (const message of endsWithPrompt ? messages.slice(0, -1) : messages) {
    appendHistory(history, message, toolNames);
  }
  const tools = (options.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }));
  return {
    system: options.system?.trim() || "You are a helpful assistant.",
    tools,
    history,
    prompt: endsWithPrompt ? textOf(last.content) : CONTINUE_PROMPT,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    // Tool-free requests transform user text (translate, summarize, Q&A over transcripts).
    permissive: tools.length === 0,
  };
}

function appendHistory(history: HistoryEntry[], message: LlmMessage, toolNames: Map<string, string>): void {
  if (message.role === "user") {
    for (const result of toolResultsOf(message)) {
      const body = result.is_error ? `Error: ${result.content}` : result.content || "(no output)";
      history.push({ type: "toolOutput", id: result.tool_use_id, name: toolNames.get(result.tool_use_id) ?? "tool", text: body });
    }
    const text = textOf(message.content);
    if (text) history.push({ type: "prompt", text });
    return;
  }
  const text = textOf(message.content);
  if (text) history.push({ type: "response", text });
  if (typeof message.content === "string") return;
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  for (const block of message.content) {
    if (block.type !== "tool_use") continue;
    toolNames.set(block.id, block.name);
    calls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
  }
  if (calls.length) history.push({ type: "toolCalls", calls });
}

function textOf(content: string | LlmContentBlock[]): string {
  if (typeof content === "string") return content.trim();
  return content
    .filter((block): block is Extract<LlmContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function toolResultsOf(message: LlmMessage | undefined): ToolResultBlock[] {
  if (!message || message.role !== "user" || typeof message.content === "string") return [];
  return message.content.filter((block): block is ToolResultBlock => block.type === "tool_result");
}

function parseArguments(json: string): any {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

type NativeEvent = {
  kind: string;
  text?: string;
  calls?: Array<{ id: string; name: string; arguments: string }>;
  code?: string;
  message?: string;
};

/** Generations parked in tool calls, by call id. */
const parked = new Map<string, Generation>();
/** Every unfinished generation, so its native object outlives the caller's handle. */
const live = new Set<Generation>();

/**
 * One native generation, possibly spanning several loop iterations: each
 * iteration ends at a batch of tool calls (or the end of the reply), and the
 * next one resumes it with the results.
 */
class Generation {
  private readonly native: any;
  private options: LlmStreamOptions | null;
  private iteration = 0;
  private text = "";
  private callIds: string[] = [];
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(options: LlmStreamOptions) {
    this.options = options;
    this.native = FaceclawSystemLanguageModel.new();
    this.native.eventHandler = (json: string) => this.onEvent(String(json));
    live.add(this);
  }

  start(request: SystemModelRequest): LlmStreamHandle {
    this.native.start(JSON.stringify(request));
    return this.handle();
  }

  /** Whether these results answer this generation's parked calls. */
  awaits(results: ToolResultBlock[]): boolean {
    return !this.closed && results.some((result) => this.callIds.includes(result.tool_use_id));
  }

  resume(options: LlmStreamOptions, results: ToolResultBlock[]): LlmStreamHandle {
    this.unpark();
    this.options = options;
    this.iteration++;
    this.text = "";
    this.native.resolveToolCalls(
      JSON.stringify(results.map((result) => ({ id: result.tool_use_id, content: result.content, isError: Boolean(result.is_error) }))),
    );
    return this.handle();
  }

  cancel(): void {
    if (this.closed) return;
    this.close();
    try {
      this.native.cancel();
    } catch {
      // ignore
    }
  }

  private handle(): LlmStreamHandle {
    const iteration = this.iteration;
    // A stale handle (an earlier iteration's) still cancels a generation parked
    // since then: its owner gave up on the turn.
    return { cancel: () => { if (this.iteration === iteration || this.options === null) this.cancel(); } };
  }

  private close(): void {
    this.closed = true;
    this.unpark();
    this.options = null;
    this.native.eventHandler = null;
    live.delete(this);
  }

  private park(ids: string[]): void {
    this.callIds = ids;
    for (const id of ids) parked.set(id, this);
    this.expiry = setTimeout(() => {
      console.warn("[local-llm] abandoning an on-device generation whose tool results never came back");
      this.cancel();
    }, PARKED_TIMEOUT_MS);
  }

  private unpark(): void {
    for (const id of this.callIds) {
      if (parked.get(id) === this) parked.delete(id);
    }
    this.callIds = [];
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
  }

  private onEvent(json: string): void {
    if (this.closed) return;
    let event: NativeEvent;
    try {
      event = JSON.parse(json);
    } catch {
      return;
    }
    if (event.kind === "log") {
      console.log(`[local-llm] ${event.message ?? ""}`);
      return;
    }
    const options = this.options;
    if (!options) return;
    switch (event.kind) {
      case "delta": {
        const delta = event.text ?? "";
        this.text += delta;
        options.onTextDelta?.(delta, this.text);
        return;
      }
      case "toolCalls": {
        const calls = event.calls ?? [];
        const text = this.text.trim();
        const content: LlmContentBlock[] = text ? [{ type: "text", text }] : [];
        for (const call of calls) {
          content.push({ type: "tool_use", id: call.id, name: call.name, input: parseArguments(call.arguments) });
        }
        this.options = null;
        this.park(calls.map((call) => call.id));
        options.onDone({ text, content, stopReason: "tool_use" });
        return;
      }
      case "done": {
        this.close();
        const text = this.text.trim();
        options.onDone({ text, content: text ? [{ type: "text", text }] : [], stopReason: "end_turn" });
        return;
      }
      case "error": {
        this.close();
        if (event.code === "refusal") {
          options.onDone({ text: this.text.trim(), content: [], stopReason: "refusal" });
        } else {
          options.onError(event.message || "The on-device model failed");
        }
        return;
      }
    }
  }
}

/**
 * Stream a reply from the system model. A request whose history ends in tool
 * results for a parked generation resumes it; anything else starts afresh.
 */
export function streamLocalModel(options: LlmStreamOptions): LlmStreamHandle {
  const availability = localModelAvailability();
  if (availability !== "available") {
    setTimeout(() => options.onError(UNAVAILABLE_MESSAGE[availability]), 0);
    return { cancel: () => {} };
  }
  const results = toolResultsOf(options.messages[options.messages.length - 1]);
  const waiting = results.map((result) => parked.get(result.tool_use_id)).find(Boolean);
  if (waiting?.awaits(results)) return waiting.resume(options, results);
  let generation: Generation | null = null;
  try {
    generation = new Generation(options);
    return generation.start(buildSystemModelRequest(options));
  } catch (error) {
    generation?.cancel();
    setTimeout(() => options.onError(`On-device model failed: ${String((error as Error)?.message ?? error)}`), 0);
    return { cancel: () => {} };
  }
}
