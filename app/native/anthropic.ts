import { refineThroughExtension } from "../apps/external/extension-providers";
import { buildRefineUserMessage, REFINE_SYSTEM_PROMPT } from "../prompts";
import type {
  LlmContentBlock,
  LlmMessage,
  LlmStreamHandle,
  LlmStreamOptions,
  LlmStreamResult,
  LlmToolDefinition,
} from "../assistant/llm-protocol";

declare const com: any;

/**
 * Minimal streaming client for the Anthropic Messages API. There is no
 * official SDK for the NativeScript runtime, so this speaks raw HTTP/SSE via
 * FaceclawSseRequest (okhttp on the Java side), which delivers the response
 * body line by line on this isolate's thread.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Default model for voice continuations (and a sensible general default). */
export const DEFAULT_LLM_MODEL = "claude-sonnet-5";

/**
 * A content block in an Anthropic message. Text-only flows (dictation refine)
 * still pass a plain string for content; the assistant tool loop uses the
 * block array to carry tool_use / tool_result alongside text.
 */
export type AnthropicContentBlock = LlmContentBlock;
export type AnthropicMessage = LlmMessage;

/** An Anthropic tool definition (input_schema is snake_case as the API wants). */
export type AnthropicToolDefinition = LlmToolDefinition;
export type AnthropicStreamResult = LlmStreamResult;
export type AnthropicStreamOptions = Omit<LlmStreamOptions, "model"> & { model?: string };

/** Accumulator for one streamed content block before it is finalized. */
type StreamingBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; inputJson: string };

export type AnthropicStreamHandle = LlmStreamHandle;

export function streamAnthropicMessage(options: AnthropicStreamOptions): AnthropicStreamHandle {
  const apiKey = options.apiKey.trim();
  let request: any = null;
  let settled = false;
  let text = "";
  let stopReason: string | null = null;
  // Content blocks, keyed by their SSE `index`, assembled as deltas arrive.
  const blocks = new Map<number, StreamingBlock>();

  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    options.onError(message);
  };
  const done = () => {
    if (settled) return;
    settled = true;
    options.onDone({ text, content: finalizeBlocks(blocks), stopReason });
  };

  if (!global.isAndroid) {
    // Deferred so the caller gets its handle back before the callback runs.
    setTimeout(() => fail("Anthropic API is only wired up on Android"), 0);
    return { cancel: () => {} };
  }
  if (!apiKey) {
    setTimeout(() => fail("No Anthropic API key set"), 0);
    return { cancel: () => {} };
  }

  const body: any = {
    model: options.model ?? DEFAULT_LLM_MODEL,
    max_tokens: options.maxTokens ?? 8192,
    stream: true,
    messages: options.messages,
  };
  if (options.system) body.system = options.system;
  if (options.tools?.length) body.tools = options.tools;
  if (options.effort) body.output_config = { effort: options.effort };

  const listener = new com.faceclaw.app.FaceclawSseListener({
    onLine: (line: string) => {
      if (settled) return;
      const event = parseSseDataLine(String(line));
      if (!event) return;
      switch (event.type) {
        case "content_block_start": {
          const index = Number(event.index);
          const block = event.content_block;
          if (block?.type === "tool_use") {
            blocks.set(index, {
              type: "tool_use",
              id: String(block.id ?? ""),
              name: String(block.name ?? ""),
              inputJson: "",
            });
          } else if (block?.type === "text") {
            blocks.set(index, { type: "text", text: String(block.text ?? "") });
          }
          return;
        }
        case "content_block_delta": {
          const index = Number(event.index);
          if (event.delta?.type === "text_delta") {
            const delta = String(event.delta.text ?? "");
            text += delta;
            const existing = blocks.get(index);
            if (existing?.type === "text") {
              existing.text += delta;
            } else {
              blocks.set(index, { type: "text", text: delta });
            }
            options.onTextDelta?.(delta, text);
          } else if (event.delta?.type === "input_json_delta") {
            const existing = blocks.get(index);
            if (existing?.type === "tool_use") {
              existing.inputJson += String(event.delta.partial_json ?? "");
            }
          }
          return;
        }
        case "message_delta":
          if (event.delta?.stop_reason) {
            stopReason = String(event.delta.stop_reason);
          }
          return;
        case "message_stop":
          done();
          return;
        case "error":
          fail(`Anthropic: ${String(event.error?.message ?? event.error?.type ?? "stream error")}`);
          return;
        default:
          // message_start, content_block_stop, ping — nothing to do.
          return;
      }
    },
    onHttpError: (code: number, errorBody: string) => {
      fail(describeHttpError(Number(code), String(errorBody)));
    },
    onComplete: () => {
      // Normally message_stop settles first; a clean EOF without it still
      // resolves with whatever streamed.
      done();
    },
    onFailure: (message: string) => {
      fail(`Anthropic connection failed: ${String(message)}`);
    },
  });

  const headers = Array.create("java.lang.String", 4) as string[];
  headers[0] = "x-api-key";
  headers[1] = apiKey;
  headers[2] = "anthropic-version";
  headers[3] = ANTHROPIC_VERSION;
  try {
    request = new com.faceclaw.app.FaceclawSseRequest(ANTHROPIC_URL, JSON.stringify(body), headers, listener);
  } catch (error) {
    setTimeout(() => fail(`Anthropic request failed: ${String((error as Error)?.message ?? error)}`), 0);
    return { cancel: () => {} };
  }

  return {
    cancel: () => {
      settled = true;
      try {
        request?.cancel();
      } catch {
        // ignore
      }
    },
  };
}

/** Assemble the streamed blocks (in index order) into final content blocks. */
function finalizeBlocks(blocks: Map<number, StreamingBlock>): AnthropicContentBlock[] {
  const content: AnthropicContentBlock[] = [];
  for (const index of Array.from(blocks.keys()).sort((a, b) => a - b)) {
    const block = blocks.get(index)!;
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else {
      let input: any = {};
      const trimmed = block.inputJson.trim();
      if (trimmed) {
        try {
          input = JSON.parse(trimmed);
        } catch {
          // A tool_use whose JSON never completed (e.g. truncated stream); pass
          // empty args and let the tool handler report what's missing.
        }
      }
      content.push({ type: "tool_use", id: block.id, name: block.name, input });
    }
  }
  return content;
}

/** Parse one SSE line; returns the JSON payload of a data: line, else null. */
function parseSseDataLine(line: string): any | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function describeHttpError(code: number, body: string): string {
  let detail = "";
  try {
    detail = String(JSON.parse(body)?.error?.message ?? "");
  } catch {
    // non-JSON error body; fall through to the generic text
  }
  switch (code) {
    case 401:
      return "Anthropic: invalid API key";
    case 403:
      return "Anthropic: API key lacks permission";
    case 429:
      return "Anthropic: rate limited, try again shortly";
    case 500:
    case 529:
      return "Anthropic: service overloaded, try again shortly";
    default:
      return `Anthropic: HTTP ${code}${detail ? ` (${detail})` : ""}`;
  }
}

export type RefineDictationOptions = {
  apiKey: string;
  original: string;
  followup: string;
  onTextDelta?: (delta: string, textSoFar: string) => void;
  onDone: (text: string) => void;
  onError: (message: string) => void;
};

/**
 * Voice continuation: combine an original dictation with a follow-up
 * (appended content or a spoken edit instruction) into one edited text.
 */
export function refineDictation(options: RefineDictationOptions): AnthropicStreamHandle {
  const extension = refineThroughExtension(options); if (extension) return extension;
  return refineHostDictation(options);
}

/** Explicit host fallback bypasses global extensions and keeps host credentials private. */
export function refineHostDictation(options: RefineDictationOptions): AnthropicStreamHandle {
  return streamAnthropicMessage({
    apiKey: options.apiKey,
    model: DEFAULT_LLM_MODEL,
    system: REFINE_SYSTEM_PROMPT,
    effort: "low",
    messages: [
      {
        role: "user",
        content: buildRefineUserMessage(options.original, options.followup),
      },
    ],
    onTextDelta: options.onTextDelta,
    onDone: (result) => {
      if (result.stopReason === "refusal") {
        options.onError("Anthropic: the model declined this request");
        return;
      }
      const text = result.text.trim();
      if (!text) {
        options.onError("Anthropic: empty response");
        return;
      }
      options.onDone(text);
    },
    onError: options.onError,
  });
}
