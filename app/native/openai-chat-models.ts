import { fetchTextWithUserAgent, type TextResponse } from "../util/http";
import { normalizeOpenAiCompatibleUrl } from "./openai-chat";

export type DiscoveredCompatibleModel = {
  /** Exact identifier to send as model in Chat Completions. */
  id: string;
  /** Human-friendly catalog name, or id when the server supplies no name. */
  name: string;
  /** true/false when advertised; null means the server did not say. */
  supportsTools: boolean | null;
  offline: boolean;
  deprecated: boolean;
  beta: boolean;
};

type DiscoveryOptions = {
  baseUrl: string;
  apiKey: string;
  /** Bypass the short-lived successful-response cache. */
  forceRefresh?: boolean;
};

type DiscoveryResponse = Pick<TextResponse, "status" | "text">;
type DiscoveryHttp = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  timeoutMs: number;
  dontFollowRedirects: boolean;
}) => Promise<DiscoveryResponse>;
type DiscoveryDependencies = {
  http?: DiscoveryHttp;
  now?: () => number;
};

type CacheEntry = {
  apiKey: string;
  fetchedAt: number;
  models: DiscoveredCompatibleModel[];
};

export const COMPATIBLE_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const MAX_MODELS = 500;
const MAX_DISCOVERY_BODY_CHARS = 2_000_000;
const cache = new Map<string, CacheEntry>();

/**
 * Discover models from the configured server's own /models endpoint. No URL
 * probing, inference calls, disk persistence, or automatic model selection.
 */
export async function discoverOpenAiCompatibleModels(
  options: DiscoveryOptions,
  dependencies: DiscoveryDependencies = {},
): Promise<DiscoveredCompatibleModel[]> {
  const baseUrl = normalizeOpenAiCompatibleUrl(options.baseUrl);
  if (!baseUrl) throw new Error("Set a valid compatible API URL first");
  const apiKey = options.apiKey.trim();
  const now = dependencies.now ?? Date.now;
  const cached = cache.get(baseUrl);
  if (!options.forceRefresh && cached && cached.apiKey === apiKey && now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models;
  }

  const http = dependencies.http ?? defaultHttp;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let response: DiscoveryResponse;
  try {
    response = await http(`${baseUrl}/models`, {
      method: "GET",
      headers,
      timeoutMs: COMPATIBLE_MODEL_DISCOVERY_TIMEOUT_MS,
      // Do not forward a credential to a redirect target.
      dontFollowRedirects: true,
    });
  } catch {
    throw new Error("Could not reach the configured server");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(describeHttpError(response.status));
  }

  let body: any;
  let rawBody: string;
  try {
    rawBody = await response.text();
    if (rawBody.length > MAX_DISCOVERY_BODY_CHARS) throw new Error("too large");
    body = JSON.parse(rawBody);
  } catch {
    throw new Error("The server returned an invalid model list");
  }
  if (!body || !Array.isArray(body.data)) {
    throw new Error("The server did not return an OpenAI-compatible model list");
  }

  const models = parseModels(body.data);
  cache.set(baseUrl, { apiKey, fetchedAt: now(), models });
  return models;
}

/** Parse OpenAI data[] rows, retaining richer Venice metadata when present. */
export function parseDiscoveredCompatibleModels(rows: any[]): DiscoveredCompatibleModel[] {
  return parseModels(rows);
}

function parseModels(rows: any[]): DiscoveredCompatibleModel[] {
  const byId = new Map<string, DiscoveredCompatibleModel>();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id.trim()) continue;
    const id = row.id.trim();
    if (byId.has(id)) continue;
    const spec = row.model_spec && typeof row.model_spec === "object" ? row.model_spec : null;
    const capabilities = spec?.capabilities && typeof spec.capabilities === "object" ? spec.capabilities : null;
    const catalogName = typeof spec?.name === "string" ? spec.name.trim() : "";
    const genericName = typeof row.name === "string" ? row.name.trim() : "";
    byId.set(id, {
      id,
      name: catalogName || genericName || id,
      supportsTools: typeof capabilities?.supportsFunctionCalling === "boolean"
        ? capabilities.supportsFunctionCalling
        : null,
      offline: spec?.offline === true,
      deprecated: Boolean(spec?.deprecation),
      beta: spec?.betaModel === true || spec?.beta === true,
    });
    if (byId.size >= MAX_MODELS) break;
  }
  return Array.from(byId.values()).sort((a, b) => {
    if (a.offline !== b.offline) return a.offline ? 1 : -1;
    const aTools = a.supportsTools === true ? 0 : a.supportsTools === null ? 1 : 2;
    const bTools = b.supportsTools === true ? 0 : b.supportsTools === null ? 1 : 2;
    if (aTools !== bTools) return aTools - bTools;
    return (a.name || a.id).localeCompare(b.name || b.id) || a.id.localeCompare(b.id);
  });
}

async function defaultHttp(url: string, init: {
  method: string;
  headers: Record<string, string>;
  timeoutMs: number;
  dontFollowRedirects: boolean;
}): Promise<DiscoveryResponse> {
  return fetchTextWithUserAgent(url, init);
}

function describeHttpError(status: number): string {
  if (status === 401) return "The server rejected the API key (HTTP 401)";
  if (status === 403) return "The API key cannot list these models (HTTP 403)";
  if (status === 404) return "Model discovery is not supported at this URL (HTTP 404)";
  if (status === 429) return "The server is rate limiting requests (HTTP 429)";
  if (status >= 500) return `The server is unavailable (HTTP ${status})`;
  if (status >= 300 && status < 400) return `The server redirected the request; use its direct API URL (HTTP ${status})`;
  return `Model discovery failed (HTTP ${status})`;
}

/** Test hook; does not affect any saved setting. */
export function clearCompatibleModelDiscoveryCache(): void {
  cache.clear();
}
