import { type SseListener } from './sse-types';
import { withUserAgent } from '../util/http';
import { kotlinListener } from './kotlin-listener.ios';
export { type SseListener } from './sse-types';
declare const FaceclawKitIosSseRequest: any, FaceclawKitFaceclawSseListener: any;

/** The shared Kotlin SseStream over NSURLSession; the Kotlin side delivers every callback on the main queue, in order. */
export function openSseRequest(url: string, body: string, headers: Record<string, string>, listener: SseListener): { cancel(): void } {
  let ended = false;
  const once = (deliver: () => void) => { if (ended) return; ended = true; deliver(); };
  const nativeListener = kotlinListener(FaceclawKitFaceclawSseListener, {
    onLineLine: (line: string) => { if (!ended) listener.onLine(String(line ?? '')); },
    onHttpErrorCodeBody: (code: number, errorBody: string) => once(() => listener.onHttpError(Number(code), String(errorBody ?? ''))),
    onComplete: () => once(() => listener.onComplete()),
    onFailureMessage_: (message: string) => once(() => listener.onFailure(String(message ?? ''))),
  });
  const native = FaceclawKitIosSseRequest.alloc().initWithUrlBodyHeadersJsonListener(url, body, JSON.stringify(withUserAgent(headers)), nativeListener);
  return { cancel: () => { if (ended) return; ended = true; native.cancel(); } };
}
