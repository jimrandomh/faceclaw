import type {
  LlmContentBlock,
  LlmMessage,
  LlmStreamHandle,
  LlmStreamOptions,
} from "../assistant/llm-protocol";

import { openSseRequest, type SseListener } from "./sse";

/**
 * Minimal streaming client for the OpenAI Responses API. NativeScript cannot
 * use the Node SDK, so this shares the native streaming transport used by Anthropic.
 */

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

type StreamingOutput =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; inputJson: string; itemId: string; item: any }
  | { type: "provider_item"; item: any };

export function streamOpenAiResponse(options: LlmStreamOptions): LlmStreamHandle {
  const apiKey = options.apiKey.trim();
  let request: any = null;
  let settled = false;
  let text = "";
  let stopReason: string | null = null;
  let refusal = false;
  const outputs = new Map<number, StreamingOutput>();

  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    request?.cancel();
    options.onError(message);
  };
  const done = () => {
    if (settled) return;
    settled = true;
    request?.cancel();
    const content = finalizeOutputs(outputs);
    const hasToolUse = content.some((block) => block.type === "tool_use");
    options.onDone({
      text,
      content,
      stopReason: refusal ? "refusal" : hasToolUse ? "tool_use" : stopReason ?? "end_turn",
    });
  };

  if (!apiKey) {
    setTimeout(() => fail("No OpenAI API key set"), 0);
    return { cancel: () => { settled = true; } };
  }

  const body: any = {
    model: options.model,
    input: buildOpenAiInput(options.messages),
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: options.maxTokens ?? 8192,
  };
  if (options.system) body.instructions = options.system;
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    }));
  }
  if (options.effort) body.reasoning = { effort: options.effort };

  const listener: SseListener = {
    onLine: (line: string) => {
      if (settled) return;
      const event = parseSseDataLine(String(line));
      if (!event) return;
      const outputIndex = Number(event.output_index);
      switch (event.type) {
        case "response.output_item.added": {
          const item = event.item;
          if (item?.type === "function_call") {
            outputs.set(outputIndex, {
              type: "tool_use",
              id: String(item.call_id ?? item.id ?? ""),
              name: String(item.name ?? ""),
              inputJson: String(item.arguments ?? ""),
              itemId: String(item.id ?? ""),
              item,
            });
          } else if (item?.type === "message") {
            outputs.set(outputIndex, { type: "text", text: "" });
          } else if (item?.type === "reasoning") {
            outputs.set(outputIndex, { type: "provider_item", item });
          }
          return;
        }
        case "response.output_text.delta": {
          const delta = String(event.delta ?? "");
          text += delta;
          const output = outputs.get(outputIndex);
          if (output?.type === "text") {
            output.text += delta;
          } else {
            outputs.set(outputIndex, { type: "text", text: delta });
          }
          options.onTextDelta?.(delta, text);
          return;
        }
        case "response.function_call_arguments.delta": {
          const output = findToolOutput(outputs, outputIndex, String(event.item_id ?? ""));
          if (output) output.inputJson += String(event.delta ?? "");
          return;
        }
        case "response.output_item.done": {
          const item = event.item;
          if (item?.type === "function_call") {
            outputs.set(outputIndex, {
              type: "tool_use",
              id: String(item.call_id ?? item.id ?? ""),
              name: String(item.name ?? ""),
              inputJson: String(item.arguments ?? ""),
              itemId: String(item.id ?? ""),
              item,
            });
          } else if (item?.type === "message") {
            const output = outputs.get(outputIndex);
            const completedText = extractMessageText(item);
            outputs.set(outputIndex, {
              type: "text",
              text: completedText || (output?.type === "text" ? output.text : ""),
            });
            if (completedText && !text) text = completedText;
          } else if (item?.type === "reasoning") {
            outputs.set(outputIndex, { type: "provider_item", item });
          }
          return;
        }
        case "response.refusal.delta":
        case "response.refusal.done":
          refusal = true;
          return;
        case "response.completed":
          done();
          return;
        case "response.incomplete":
          stopReason = String(event.response?.incomplete_details?.reason ?? "incomplete");
          done();
          return;
        case "response.failed":
          fail(`OpenAI: ${String(event.response?.error?.message ?? "response failed")}`);
          return;
        case "error":
          fail(`OpenAI: ${String(event.message ?? event.error?.message ?? "stream error")}`);
          return;
        default:
          return;
      }
    },
    onHttpError: (code: number, errorBody: string) => {
      fail(describeHttpError(Number(code), String(errorBody)));
    },
    onComplete: () => {
      // A transport EOF alone must not execute an unfinished tool call.
      fail("OpenAI stream ended before the response completed");
    },
    onFailure: (message: string) => {
      fail(`OpenAI connection failed: ${String(message)}`);
    },
  };

  try {
    request = openSseRequest(OPENAI_RESPONSES_URL, JSON.stringify(body), { Authorization: `Bearer ${apiKey}` }, listener);
  } catch (error) {
    setTimeout(() => fail(`OpenAI request failed: ${String((error as Error)?.message ?? error)}`), 0);
    return { cancel: () => { settled = true; } };
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

/** Convert neutral conversation history to Responses API input items. */
function buildOpenAiInput(messages: LlmMessage[]): any[] {
  const input: any[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      input.push({ role: message.role, content: message.content });
      continue;
    }

    let pendingText = "";
    const flushText = () => {
      if (!pendingText) return;
      input.push({ role: message.role, content: pendingText });
      pendingText = "";
    };
    for (const block of message.content) {
      if (block.type === "text") {
        pendingText += block.text;
      } else if (block.type === "tool_use") {
        flushText();
        if (block.provider_item?.provider === "openai") {
          input.push(block.provider_item.item);
        } else {
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          });
        }
      } else if (block.type === "tool_result") {
        flushText();
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: block.is_error ? `Error: ${block.content}` : block.content,
        });
      } else if (block.provider === "openai") {
        flushText();
        input.push(block.item);
      }
    }
    flushText();
  }
  return input;
}

function finalizeOutputs(outputs: Map<number, StreamingOutput>): LlmContentBlock[] {
  const content: LlmContentBlock[] = [];
  for (const index of Array.from(outputs.keys()).sort((a, b) => a - b)) {
    const output = outputs.get(index)!;
    if (output.type === "text") {
      if (output.text) content.push({ type: "text", text: output.text });
      continue;
    }
    if (output.type === "provider_item") {
      content.push({ type: "provider_item", provider: "openai", item: output.item });
      continue;
    }
    let input: any = {};
    if (output.inputJson.trim()) {
      try {
        input = JSON.parse(output.inputJson);
      } catch {
        // Let the tool handler report any required arguments that are missing.
      }
    }
    content.push({
      type: "tool_use",
      id: output.id,
      name: output.name,
      input,
      provider_item: { provider: "openai", item: output.item },
    });
  }
  return content;
}

function findToolOutput(
  outputs: Map<number, StreamingOutput>,
  outputIndex: number,
  itemId: string,
): Extract<StreamingOutput, { type: "tool_use" }> | null {
  const indexed = outputs.get(outputIndex);
  if (indexed?.type === "tool_use") return indexed;
  for (const output of outputs.values()) {
    if (output.type === "tool_use" && output.itemId === itemId) return output;
  }
  return null;
}

function extractMessageText(item: any): string {
  if (!Array.isArray(item?.content)) return "";
  return item.content
    .filter((part: any) => part?.type === "output_text")
    .map((part: any) => String(part.text ?? ""))
    .join("");
}

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
    // non-JSON error body
  }
  switch (code) {
    case 401:
      return "OpenAI: invalid API key";
    case 403:
      return "OpenAI: API key lacks permission";
    case 429:
      return "OpenAI: rate limited, try again shortly";
    case 500:
    case 502:
    case 503:
    case 504:
      return "OpenAI: service unavailable, try again shortly";
    default:
      return `OpenAI: HTTP ${code}${detail ? ` (${detail})` : ""}`;
  }
}
