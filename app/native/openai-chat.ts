import type {
  LlmContentBlock,
  LlmStreamHandle,
  LlmStreamOptions,
} from "../assistant/llm-protocol";
import { openSseRequest, type SseListener } from "./sse";

/** True only for Venice's official API root, never for lookalike hosts. */
export function isVeniceApiBaseUrl(input: string): boolean {
  return normalizeOpenAiCompatibleUrl(input) === "https://api.venice.ai/api/v1";
}

/** Streaming client for OpenAI-compatible Chat Completions APIs. */
export type OpenAiCompatibleStreamOptions = LlmStreamOptions & {
  /** Explicit API root, for example https://api.venice.ai/api/v1 or https://host/api. */
  baseUrl: string;
  /** Venice-only web search; never sent to other compatible providers. */
  webSearch?: boolean;
};

type PendingToolCall = {
  id: string;
  name: string;
  inputJson: string;
};

/** Remove an optional endpoint suffix, but never guess a provider's /v1 or /api prefix. */
export function normalizeOpenAiCompatibleUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  url = url.replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
  return /^https?:\/\/[^/\s?#@\\]+(?:\/[^\s?#\\]*)?$/i.test(url) ? url : "";
}

export function streamOpenAiCompatibleChat(options: OpenAiCompatibleStreamOptions): LlmStreamHandle {
  const apiKey = options.apiKey.trim();
  const baseUrl = normalizeOpenAiCompatibleUrl(options.baseUrl);
  let request: { cancel(): void } | null = null;
  let settled = false;
  let text = "";
  let finishReason: string | null = null;
  const toolCalls = new Map<number, PendingToolCall>();
  const providerMetadata: Record<string, any> = {};

  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    request?.cancel();
    options.onError(message);
  };

  const done = () => {
    if (settled) return;
    const hasToolCalls = toolCalls.size > 0;
    // Never execute calls from a truncated stream or a length-limited response.
    if (hasToolCalls && finishReason !== "tool_calls" && finishReason !== "stop") {
      fail("OpenAI-compatible stream ended before its tool calls completed");
      return;
    }
    if (!text && !hasToolCalls) {
      fail("OpenAI-compatible provider ended the turn without a reply");
      return;
    }

    const content: LlmContentBlock[] = [];
    if (text) content.push({ type: "text", text });
    if (Object.keys(providerMetadata).length) {
      content.push({ type: "provider_item", provider: "openai-compatible", item: providerMetadata });
    }
    for (const index of Array.from(toolCalls.keys()).sort((a, b) => a - b)) {
      const call = toolCalls.get(index)!;
      if (!call.name) {
        fail("OpenAI-compatible provider returned a tool call without a name");
        return;
      }
      let input: any = {};
      if (call.inputJson.trim()) {
        try {
          input = JSON.parse(call.inputJson);
        } catch {
          fail("OpenAI-compatible provider returned malformed tool arguments");
          return;
        }
      }
      content.push({
        type: "tool_use",
        id: call.id || `call_${index + 1}`,
        name: call.name,
        input,
      });
    }

    settled = true;
    request?.cancel();
    options.onDone({
      text,
      content,
      stopReason: finishReason === "content_filter" ? "refusal"
        : hasToolCalls ? "tool_use"
          : finishReason === "length" ? "max_tokens" : "end_turn",
    });
  };

  if (!baseUrl || !options.model.trim()) {
    setTimeout(() => fail(!baseUrl
      ? "Set a valid OpenAI-compatible API URL"
      : "Set an OpenAI-compatible model ID"), 0);
    return { cancel: () => { settled = true; } };
  }

  const body: any = {
    model: options.model.trim(),
    messages: buildChatMessages(options),
    stream: true,
  };
  // Let the provider choose its default unless a one-shot feature supplies a cap.
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }
  // Provider-specific parameters must never leak to another endpoint, even
  // when a saved Venice preference is still enabled.
  if (options.webSearch === true && isVeniceApiBaseUrl(baseUrl)) {
    body.venice_parameters = { enable_web_search: "on" };
  }
  // Do not send provider-specific reasoning fields by default. Compatible
  // servers vary widely; advanced reasoning controls can be added separately.

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const listener: SseListener = {
    onLine: (line: string) => {
      if (settled || !line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === "[DONE]") {
        if (finishReason || (!toolCalls.size && text)) done();
        else fail("OpenAI-compatible stream ended before the response completed");
        return;
      }
      let event: any;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      if (event?.error) {
        fail(`OpenAI-compatible: ${String(event.error.message ?? event.error)}`);
        return;
      }
      const choice = event?.choices?.[0];
      if (!choice) return; // Usage and provider-metadata chunks may have no choices.
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        options.onTextDelta?.(delta.content, text);
      }
      // Reasoning is not displayed. Preserve provider metadata for replay in
      // multi-turn tool loops when the service supplies it.
      if (delta.reasoning_details !== undefined) providerMetadata.reasoning_details = delta.reasoning_details;
      if (delta.thought_signature !== undefined) providerMetadata.thought_signature = delta.thought_signature;
      if (Array.isArray(delta.tool_calls)) {
        delta.tool_calls.forEach((call: any, position: number) => {
          const index = Number.isInteger(call?.index) ? Number(call.index) : position;
          const pending = toolCalls.get(index) ?? { id: "", name: "", inputJson: "" };
          if (call?.id) pending.id = String(call.id);
          if (call?.function?.name) pending.name = String(call.function.name);
          if (typeof call?.function?.arguments === "string") pending.inputJson += call.function.arguments;
          toolCalls.set(index, pending);
        });
      }
      if (choice.finish_reason) finishReason = String(choice.finish_reason);
    },
    onHttpError: (code: number, errorBody: string) => fail(describeHttpError(Number(code), String(errorBody))),
    onComplete: () => {
      // Some compatible servers close after the finish chunk without [DONE].
      if (finishReason) done();
      else fail("OpenAI-compatible stream ended before the response completed");
    },
    onFailure: (message: string) => fail(`OpenAI-compatible connection failed: ${String(message)}`),
  };

  try {
    request = openSseRequest(`${baseUrl}/chat/completions`, JSON.stringify(body), headers, listener);
  } catch (error) {
    setTimeout(() => fail(`OpenAI-compatible request failed: ${String((error as Error)?.message ?? error)}`), 0);
    return { cancel: () => { settled = true; } };
  }

  return {
    cancel: () => {
      settled = true;
      try { request?.cancel(); } catch { /* ignore */ }
    },
  };
}

/** Convert neutral conversation history to Chat Completions messages. */
function buildChatMessages(options: OpenAiCompatibleStreamOptions): any[] {
  const messages: any[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });

  for (const message of options.messages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      let text = "";
      const toolCalls: any[] = [];
      let providerMetadata: Record<string, any> = {};
      for (const block of message.content) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        } else if (block.type === "provider_item" && block.provider === "openai-compatible") {
          providerMetadata = { ...providerMetadata, ...block.item };
        }
      }
      if (text || toolCalls.length) {
        messages.push({
          role: "assistant",
          content: text || (toolCalls.length ? null : ""),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          ...providerMetadata,
        });
      }
      continue;
    }

    let pendingText = "";
    const flushText = () => {
      if (!pendingText) return;
      messages.push({ role: "user", content: pendingText });
      pendingText = "";
    };
    for (const block of message.content) {
      if (block.type === "text") pendingText += block.text;
      else if (block.type === "tool_result") {
        flushText();
        messages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.is_error ? `Error: ${block.content}` : block.content,
        });
      }
    }
    flushText();
  }
  return messages;
}

function describeHttpError(code: number, body: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body);
    detail = String(parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? "");
  } catch {
    // Non-JSON error body.
  }
  switch (code) {
    case 401: return "OpenAI-compatible: invalid API key";
    case 403: return "OpenAI-compatible: API key lacks permission";
    case 429: return "OpenAI-compatible: rate limited, try again shortly";
    case 500:
    case 502:
    case 503:
    case 504:
      return "OpenAI-compatible: service unavailable, try again shortly";
    default: return `OpenAI-compatible: HTTP ${code}${detail ? ` (${detail})` : ""}`;
  }
}
