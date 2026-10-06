import { USER_AGENT } from "../version";

declare const com: any;

/**
 * fetch() with our User-Agent attached. Every outbound HTTP request in the app
 * should go through this instead of calling fetch() directly, so servers see a
 * consistent, identifiable client string. A User-Agent the caller supplies
 * explicitly wins (e.g. an API that wants contact details appended).
 *
 * Requests made from the Java side (FaceclawSseRequest, FaceclawWebSocket,
 * FaceclawModelDownloader) get the same header from FaceclawHttp's okhttp
 * interceptor.
 */
export function fetchWithUserAgent(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, headers: withUserAgent(init?.headers) });
}

/** The parts of a fetch() Response that fetchTextWithUserAgent provides. */
export interface TextResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

/**
 * fetchWithUserAgent for text/JSON bodies, decoded on the Java side.
 * NativeScript's fetch() polyfill reads every body as a blob, and on Android
 * that copies it from the Java byte[] into JS one bridge call per byte
 * (Uint8Array.from in http-request's toArrayBuffer): ~160ms of main thread
 * for one Nightscout refresh. Here the body crosses once, as a string.
 */
export async function fetchTextWithUserAgent(
  url: string,
  init?: { method?: string; headers?: HeadersInit; body?: string },
): Promise<TextResponse> {
  // Required lazily so the Node test harness can load this module (via
  // fetchWithUserAgent's users) without mocking @nativescript/core. Only the
  // http module: the @nativescript/core barrel would pull the UI classes
  // (Frame's FragmentClass etc.) into the app workers that import this file,
  // and their duplicate extends break the static binding generator.
  const { request } = require("@nativescript/core/http") as typeof import("@nativescript/core/http");
  const response = await request({
    url,
    method: init?.method ?? "GET",
    headers: withUserAgent(init?.headers),
    content: init?.body,
  });
  const status = response.statusCode;
  let body: string | undefined;
  const read = (): string => {
    if (body === undefined) {
      const content = response.content as any;
      if (!content) body = "";
      // HttpResponseEncoding.UTF8 is 0, so content.toString() can't ask for
      // UTF-8 explicitly on Android; decode the raw ByteArrayOutputStream.
      else if (global.isAndroid) body = String(content.raw.toString("UTF-8"));
      else body = content.toString();
    }
    return body!;
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => read(),
    json: async () => JSON.parse(read()),
  };
}

/** Copies headers into a plain record, adding our User-Agent if absent. */
export function withUserAgent(headers?: HeadersInit): Record<string, string> {
  const merged: Record<string, string> = {};
  if (headers) {
    if (Array.isArray(headers)) {
      for (const [name, value] of headers) merged[name!] = value!;
    } else if (typeof (headers as Headers).forEach === "function") {
      (headers as Headers).forEach((value, name) => {
        merged[name] = value;
      });
    } else {
      Object.assign(merged, headers as Record<string, string>);
    }
  }
  const hasUserAgent = Object.keys(merged).some((name) => name.toLowerCase() === "user-agent");
  if (!hasUserAgent) merged["User-Agent"] = USER_AGENT;
  return merged;
}

/**
 * Hands our User-Agent to the Java networking helpers. Called once during app
 * startup; the value is a process-wide static, so workers pick it up too.
 */
export function installNativeUserAgent(): void {
  if (!global.isAndroid) return;
  try {
    com.faceclaw.app.FaceclawHttp.setUserAgent(USER_AGENT);
  } catch {
    // Non-fatal: okhttp falls back to FaceclawHttp's built-in default.
  }
}
