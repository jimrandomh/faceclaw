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
