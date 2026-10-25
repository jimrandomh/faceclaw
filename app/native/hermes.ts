import type { LlmStreamHandle, LlmStreamOptions } from "../assistant/llm-protocol";
import { openSseRequest, type SseListener } from "./sse";

/**
 * Streaming client for a Hermes Agent gateway's OpenAI-compatible API server
 * (POST {baseUrl}/chat/completions). Hermes is an agent with its own tools and
 * memory, so only the latest user message is sent: the X-Hermes-Session-Id header
 * keeps the conversation on the server. Faceclaw's own tools are not offered.
 */

export type HermesStreamOptions = LlmStreamOptions & {
  baseUrl: string;
  sessionId: string;
};

/** The API root from what a user typed: adds /v1 to a bare host. Empty when unusable. */
export function normalizeHermesUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+/i.test(url)) return "";
  url = url.replace(/\/chat\/completions$/i, "");
  if (/^https?:\/\/[^/]+$/i.test(url)) url += "/v1";
  return url;
}

export function streamHermesChat(options: HermesStreamOptions): LlmStreamHandle {
  let request: { cancel(): void } | null = null;
  let settled = false;
  let text = "";
  let finishReason: string | null = null;

  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    request?.cancel();
    options.onError(message);
  };
  const done = () => {
    if (settled) return;
    // A failed or interrupted run still ends with a finish chunk and [DONE]; the
    // chunk carries an error object only when Hermes has a message to show.
    if (finishReason === "error") {
      fail("Hermes: the agent run failed");
      return;
    }
    if (finishReason === "cancelled") {
      fail("Hermes: the agent run was interrupted");
      return;
    }
    if (!text) {
      fail("Hermes ended the turn without a reply");
      return;
    }
    settled = true;
    request?.cancel();
    options.onDone({ text, content: [{ type: "text", text }], stopReason: finishReason === "length" ? "max_tokens" : "end_turn" });
  };

  const baseUrl = normalizeHermesUrl(options.baseUrl);
  const last = [...options.messages].reverse().find((message) => message.role === "user");
  const prompt = typeof last?.content === "string" ? last.content : "";
  if (!baseUrl || !prompt) {
    setTimeout(() => fail(baseUrl ? "Nothing to send to Hermes" : "No Hermes URL set"), 0);
    return { cancel: () => { settled = true; } };
  }

  const messages = [
    ...(options.system ? [{ role: "system", content: options.system }] : []),
    { role: "user", content: prompt },
  ];
  const body = JSON.stringify({ model: options.model, stream: true, messages });
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Hermes-Session-Id": options.sessionId };
  if (options.apiKey.trim()) headers.Authorization = `Bearer ${options.apiKey.trim()}`;

  const listener: SseListener = {
    onLine: (line: string) => {
      if (settled || !line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        done();
        return;
      }
      let event: any;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      if (event?.error) {
        fail(`Hermes: ${String(event.error.message ?? event.error)}`);
        return;
      }
      const choice = event?.choices?.[0];
      // reasoning_content is the agent's thinking; only the answer goes to the glasses.
      // Hermes opens its answer with blank lines after the reasoning; drop them.
      const delta = text ? choice?.delta?.content : String(choice?.delta?.content ?? "").trimStart();
      if (typeof delta === "string" && delta) {
        text += delta;
        options.onTextDelta?.(delta, text);
      }
      if (choice?.finish_reason) finishReason = String(choice.finish_reason);
    },
    onHttpError: (code: number, errorBody: string) => fail(describeHttpError(Number(code), String(errorBody))),
    // Some servers close without [DONE] after the final chunk. Hermes always sends
    // a finish_reason, so a stream closed without one was cut off.
    onComplete: () => (finishReason ? done() : fail(text ? "Hermes: the reply was cut off" : "Hermes stream ended without a reply")),
    onFailure: (message: string) => fail(`Hermes connection failed: ${String(message)}`),
  };

  try {
    request = openSseRequest(`${baseUrl}/chat/completions`, body, headers, listener);
  } catch (error) {
    setTimeout(() => fail(`Hermes request failed: ${String((error as Error)?.message ?? error)}`), 0);
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

function describeHttpError(code: number, body: string): string {
  if (code === 401 || code === 403) return "Hermes: the API server rejected the key";
  let detail = "";
  try {
    detail = String(JSON.parse(body)?.error?.message ?? "");
  } catch {
    // non-JSON error body
  }
  return `Hermes: HTTP ${code}${detail ? ` (${detail})` : ""}`;
}
