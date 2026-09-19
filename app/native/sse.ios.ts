import { type SseListener } from './sse-types';
import { withUserAgent } from '../util/http';
export { type SseListener } from './sse-types';
declare const FaceclawSseRequest: any;

/** Drain native events on the requesting JS isolate, never on a URLSession thread. */
export function openSseRequest(url: string, body: string, headers: Record<string, string>, listener: SseListener): { cancel(): void } {
  const native = FaceclawSseRequest.alloc().initWithURLBodyHeaders(url, body, JSON.stringify(withUserAgent(headers)));
  let ended = false;
  const cancel = () => { if (ended) return; ended = true; clearInterval(timer); native.cancel(); };
  const timer = setInterval(() => {
    try {
      for (const event of JSON.parse(native.takeEvents())) {
        if (ended) break;
        if (event.kind === 'line') listener.onLine(event.text);
        else {
          cancel();
          if (event.kind === 'complete') listener.onComplete();
          else if (event.kind === 'http-error') listener.onHttpError(event.code, event.text);
          else listener.onFailure(event.text);
        }
      }
    } catch (error) {
      cancel(); listener.onFailure(String((error as Error)?.message ?? error));
    }
  }, 25);
  return { cancel };
}
