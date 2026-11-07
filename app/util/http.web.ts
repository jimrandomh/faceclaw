export interface TextResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

import { demoNightscoutResponse } from "../web/demo-data/nightscout";

/**
 * Browsers send their own User-Agent and may preflight a custom one, so unlike
 * the native builds these leave it alone.
 */
export function fetchWithUserAgent(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.delete("User-Agent");
  return fetch(url, { ...init, headers });
}

export async function fetchTextWithUserAgent(
  url: string,
  init?: { method?: string; headers?: HeadersInit; body?: string; timeoutMs?: number; dontFollowRedirects?: boolean },
): Promise<TextResponse> {
  const sample = demoNightscoutResponse(url);
  if (sample !== null) {
    const text = JSON.stringify(sample);
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
  }
  const controller = new AbortController();
  const timer = init?.timeoutMs ? setTimeout(() => controller.abort(), init.timeoutMs) : null;
  try {
    const response = await fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
      redirect: init?.dontFollowRedirects ? "manual" : "follow",
      signal: controller.signal,
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text: async () => text, json: async () => JSON.parse(text) };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function withUserAgent(headers?: HeadersInit): Record<string, string> {
  const merged: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => { merged[name] = value; });
  return merged;
}

export function installNativeUserAgent(): void {}
