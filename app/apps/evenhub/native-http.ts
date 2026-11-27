/** Android native transport for one hosted EvenHub app session. */
declare const com: any;

import { appCacheDirPath } from "../../native/file-access";

export const NATIVE_HTTP_DEFAULT_TIMEOUT_MS = 30_000;
export const NATIVE_HTTP_DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const NATIVE_HTTP_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
export const NATIVE_HTTP_DEFAULT_CHUNK_BYTES = 256 * 1024;
export const NATIVE_HTTP_MAX_CHUNK_BYTES = 1024 * 1024;

export type NativeHttpResponse = {
  requestId: string;
  status: number;
  url: string;
  headers: Array<[string, string]>;
};

export type NativeHttpChunk = { data: string; done: boolean };

export type NativeHttpRequestOptions = {
  url: string;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
};

export function boundedNativeHttpInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  name: string,
  allowZero = false,
): number {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)
    || candidate < (allowZero ? 0 : 1) || candidate > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${allowZero ? 0 : 1} and ${maximum}`);
  }
  return candidate;
}

export function nativeHttpRequestId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError("requestId must be a non-empty string of at most 128 characters");
  }
  return value;
}

export function nativeHttpOptions(value: unknown): NativeHttpRequestOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("nativeHttpRequest options must be an object");
  }
  const options = value as Record<string, unknown>;
  if (typeof options.url !== "string" || options.url.length === 0) {
    throw new TypeError("url must be a non-empty absolute HTTP(S) URL");
  }
  let parsed: URL;
  try { parsed = new URL(options.url); } catch {
    throw new TypeError("url must be a non-empty absolute HTTP(S) URL");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.host) {
    throw new TypeError("url must be a non-empty absolute HTTP(S) URL");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("url must not contain credentials");
  }
  const method = options.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") throw new TypeError("method must be GET or HEAD");
  if (options.headers !== undefined
    && (options.headers === null || typeof options.headers !== "object" || Array.isArray(options.headers))) {
    throw new TypeError("headers must be a string-to-string object");
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries((options.headers ?? {}) as Record<string, unknown>)) {
    if (!name || typeof headerValue !== "string") throw new TypeError("headers must be a string-to-string object");
    headers[name] = headerValue;
  }
  return {
    url: options.url,
    method,
    headers,
    timeoutMs: boundedNativeHttpInteger(
      options.timeoutMs, NATIVE_HTTP_DEFAULT_TIMEOUT_MS, 2_147_483_647, "timeoutMs",
    ),
    maxBytes: boundedNativeHttpInteger(
      options.maxBytes, NATIVE_HTTP_DEFAULT_MAX_BYTES, NATIVE_HTTP_MAX_REQUEST_BYTES, "maxBytes",
    ),
  };
}

/** Thin JSON-safe bridge to FaceclawEvenHubHttp, which owns files and calls. */
export class EvenHubNativeHttp {
  private readonly native: any;
  private readonly listener: any;
  private readonly pending = new Map<string, {
    resolve: (response: NativeHttpResponse) => void;
    reject: (error: Error) => void;
  }>();
  private closed = false;

  constructor() {
    if (!global.isAndroid) throw new Error("nativeHttpRequest is only available on Android.");
    this.listener = new com.faceclaw.app.FaceclawEvenHubHttpListener({
      onResponse: (requestId: string, status: number, url: string, headersJson: string) => {
        const request = this.pending.get(String(requestId));
        if (!request) return;
        this.pending.delete(String(requestId));
        try {
          const headers: unknown = JSON.parse(String(headersJson));
          if (!Number.isInteger(status) || status < 0 || typeof url !== "string" || url.length === 0
            || !isNativeHttpHeaders(headers)) {
            throw new Error("Invalid native response metadata.");
          }
          request.resolve({ requestId: String(requestId), status, url, headers });
        } catch {
          this.native.cancel(requestId);
          request.reject(new Error("Native HTTP returned malformed response metadata."));
        }
      },
      onFailure: (requestId: string, message: string | null) => {
        const request = this.pending.get(String(requestId));
        if (!request) return;
        this.pending.delete(String(requestId));
        request.reject(new Error(String(message || "Native HTTP request failed.")));
      },
    });
    this.native = new com.faceclaw.app.FaceclawEvenHubHttp(appCacheDirPath(), this.listener);
  }

  request(options: NativeHttpRequestOptions): Promise<NativeHttpResponse> {
    if (this.closed) return Promise.reject(new Error("The app session is closed."));
    const method = options.method ?? "GET";
    const timeoutMs = options.timeoutMs ?? NATIVE_HTTP_DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? NATIVE_HTTP_DEFAULT_MAX_BYTES;
    const entries = Object.entries(options.headers ?? {});
    const nativeHeaders = Array.create("java.lang.String", entries.length * 2);
    entries.forEach(([name, value], index) => {
      nativeHeaders[index * 2] = name;
      nativeHeaders[index * 2 + 1] = value;
    });
    let requestId: string;
    try {
      requestId = String(this.native.request(options.url, method, nativeHeaders, timeoutMs, maxBytes));
    } catch {
      // URL/header parser exceptions can echo caller-supplied credentials.
      // Do not return native diagnostics to the page or downstream loggers.
      return Promise.reject(new Error("Native HTTP request could not be started."));
    }
    return new Promise<NativeHttpResponse>((resolve, reject) => {
      if (this.closed) {
        this.native.cancel(requestId);
        reject(new Error("The app session is closed."));
      } else {
        this.pending.set(requestId, { resolve, reject });
      }
    });
  }

  read(requestId: string, offset = 0, maxBytes = NATIVE_HTTP_DEFAULT_CHUNK_BYTES): NativeHttpChunk {
    if (this.closed) throw new Error("The app session is closed.");
    try {
      const parsed: unknown = JSON.parse(String(this.native.read(requestId, offset, maxBytes)));
      if (!isNativeHttpChunk(parsed)) throw new Error("Native HTTP returned malformed response chunk.");
      return { data: parsed[0], done: parsed[1] };
    } catch (error) {
      if (error instanceof Error && error.message === "Native HTTP returned malformed response chunk.") {
        throw error;
      }
      // oxlint-disable-next-line preserve-caught-error -- Native exceptions can contain private request details.
      throw new Error("Native HTTP response could not be read.");
    }
  }

  cancel(requestId: string): void {
    if (this.closed) return;
    this.pending.get(requestId)?.reject(new Error("Native HTTP request cancelled."));
    this.pending.delete(requestId);
    this.native.cancel(requestId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) request.reject(new Error("The app session is closed."));
    this.pending.clear();
    this.native.close();
  }
}

function isNativeHttpHeaders(value: unknown): value is Array<[string, string]> {
  return Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.length === 2
    && typeof entry[0] === "string" && typeof entry[1] === "string");
}

function isNativeHttpChunk(value: unknown): value is [string, boolean] {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === "string" && isCanonicalBase64(value[0]) && typeof value[1] === "boolean";
}

/** Android Base64.NO_WRAP, including canonical padding bits for non-empty data. */
function isCanonicalBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding === 0) return true;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const penultimate = alphabet.indexOf(value[value.length - padding - 1]);
  return padding === 2 ? (penultimate & 15) === 0 : (penultimate & 3) === 0;
}
