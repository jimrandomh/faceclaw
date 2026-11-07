import { type SseListener } from "./sse-types";
export { type SseListener } from "./sse-types";

/** The SSE POST the assistant backends use, line by line over a fetch stream. */
export function openSseRequest(url: string, body: string, headers: Record<string, string>, listener: SseListener): { cancel(): void } {
  const controller = new AbortController();
  let ended = false;
  const once = (deliver: () => void) => { if (!ended) { ended = true; deliver(); } };
  void (async () => {
    try {
      const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text();
        once(() => listener.onHttpError(response.status, text));
        return;
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (!ended) listener.onLine(line.replace(/\r$/, ""));
      }
      if (pending && !ended) listener.onLine(pending);
      once(() => listener.onComplete());
    } catch (error) {
      once(() => listener.onFailure(error instanceof Error ? error.message : String(error)));
    }
  })();
  return { cancel: () => { ended = true; controller.abort(); } };
}
