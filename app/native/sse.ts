import { type SseListener } from './sse-types';
export { type SseListener } from './sse-types';
declare const com: any;

/** Android delivers callbacks on the requesting isolate's Looper. */
export function openSseRequest(url: string, body: string, headers: Record<string, string>, listener: SseListener): { cancel(): void } {
  const entries = Object.entries(headers);
  const nativeHeaders = Array.create('java.lang.String', entries.length * 2);
  entries.forEach(([name, value], index) => { nativeHeaders[index * 2] = name; nativeHeaders[index * 2 + 1] = value; });
  return new com.faceclaw.app.FaceclawSseRequest(url, body, nativeHeaders, new com.faceclaw.app.FaceclawSseListener(listener));
}
