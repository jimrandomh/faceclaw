/**
 * Client for the private storefront endpoints used by the official Even app.
 *
 * This is intentionally separate from the EvenHub JS compatibility bridge:
 * it only discovers and downloads public .ehpk packages. Authentication is
 * the same signed-header scheme used by the firmware API.
 */
import { Application } from "@nativescript/core";
import {
  getEvenHubToken,
  hasEvenHubCredentials,
  invalidateEvenHubToken,
  saveEvenHubSession,
} from "./credentials";
import { fetchWithUserAgent } from "../../util/http";

declare const android: any;

const API_HOST = "https://api.evenrealities.com";
const PUBLIC_CDN_HOST = "https://cdn-pub.evenhub.evenrealities.com";
const SIGN_KEY = "a7964f42c39200cfa25c258b7a311b106e20232173667e543c34ced91d63b404";
const REQUEST_TIMEOUT_MS = 30_000;

export type EvenHubStoreApp = {
  id: number;
  packageId: string;
  name: string;
  creatorName: string;
  tagline: string;
  description: string;
  categories: string[];
  installCount: number;
  likeCount: number;
  firstPublishedAt: string;
  /** Public-CDN-relative SVG/raster artwork path. */
  iconPath: string;
  version: string;
  changelog: string;
  fileSize: number;
};

export type EvenHubStorePage = {
  apps: EvenHubStoreApp[];
  total: number;
  page: number;
  pageSize: number;
};

type ApiEnvelope = {
  code?: number;
  msg?: string;
  data?: unknown;
};

type DownloadMetadata = {
  url?: unknown;
  size?: unknown;
  public_key?: unknown;
  privacy_link?: unknown;
  meta?: unknown;
};

export type EvenHubAppDownload = {
  bytes: Uint8Array;
  privacyPolicyUrl: string;
};

export function isEvenHubStoreConfigured(): boolean {
  return hasEvenHubCredentials();
}

export class EvenHubAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvenHubAuthenticationError";
  }
}

export class EvenHubApiClient {
  private loginPromise: Promise<string> | null = null;

  async listApps(page = 1, category = ""): Promise<EvenHubStorePage> {
    const query: Record<string, string | number> = { page, page_size: 40 };
    if (category) query.category = category;
    const data = await this.authenticatedRequest("GET", "/v2/evenhub/leaderboard", { query });
    const root = asRecord(data);
    const list = Array.isArray(root.list) ? root.list : [];
    return {
      apps: list.map(parseStoreApp).filter((app): app is EvenHubStoreApp => app !== null),
      total: finiteNumber(root.total),
      page: finiteNumber(root.page) || page,
      pageSize: finiteNumber(root.page_size) || 40,
    };
  }

  async getAppDetail(packageId: string): Promise<Record<string, unknown>> {
    const data = await this.authenticatedRequest("GET", "/v2/evenhub/app/detail", {
      query: { package_id: packageId, branch_name: "public" },
    });
    return asRecord(data);
  }

  async getStoreAppDetail(packageId: string): Promise<EvenHubStoreApp | null> {
    return parseStoreApp(await this.getAppDetail(packageId));
  }

  /** Resolve the signed download URL, then fetch and sanity-check its EHPK. */
  async downloadApp(packageId: string): Promise<EvenHubAppDownload> {
    const data = await this.authenticatedRequest("POST", "/v2/evenhub/app/download", {
      body: { package_id: packageId, branch: "public" },
    });
    const metadata = asRecord(data) as DownloadMetadata;
    const url = typeof metadata.url === "string" ? metadata.url : "";
    if (!url.startsWith("https://")) throw new Error("EvenHub returned no package download URL.");

    const response = await fetchWithTimeout(url, {}, 60_000);
    if (!response.ok) throw new Error(`EvenHub package download failed (HTTP ${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const expectedSize = finiteNumber(metadata.size);
    if (expectedSize > 0 && bytes.length !== expectedSize) {
      throw new Error(`EvenHub package was truncated (${bytes.length} of ${expectedSize} bytes).`);
    }
    if (bytes.length < 20 || bytes[0] !== 0x45 || bytes[1] !== 0x48 || bytes[2] !== 0x50 || bytes[3] !== 0x4b) {
      throw new Error("EvenHub download is not an EHPK package.");
    }
    return {
      bytes,
      // The production API currently returns a CDN-relative `privacy_link`
      // at the response root. Accept the nested serialization shape too.
      privacyPolicyUrl: resolvePrivacyPolicyUrl(
        stringValue(metadata.privacy_link).trim()
          ? metadata.privacy_link
          : asRecord(metadata.meta).privacy_link,
      ),
    };
  }

  /** Download one public storefront asset, constrained to Even's CDN path. */
  async downloadPublicAsset(path: string): Promise<{ bytes: Uint8Array; extension: string }> {
    const cleanPath = path.replace(/^\/+/, "");
    if (!/^prod\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\.(?:svg|png|webp|jpe?g)$/i.test(cleanPath) || cleanPath.includes("..")) {
      throw new Error("EvenHub returned an invalid public asset path.");
    }
    const response = await fetchWithTimeout(`${PUBLIC_CDN_HOST}/${cleanPath}`, {}, 30_000);
    if (!response.ok) throw new Error(`EvenHub icon download failed (HTTP ${response.status}).`);
    const contentLength = Number(response.headers.get("Content-Length") ?? 0);
    if (contentLength > 1_000_000) throw new Error("EvenHub icon is unexpectedly large.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 1_000_000) throw new Error("EvenHub icon is empty or too large.");
    const extension = cleanPath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
    return { bytes, extension: extension === "jpeg" ? "jpg" : extension };
  }

  async signIn(email: string, password: string, remember: boolean): Promise<void> {
    if (!this.loginPromise) {
      this.loginPromise = this.login(email, password, remember).finally(() => {
        this.loginPromise = null;
      });
    }
    await this.loginPromise;
  }

  private async authenticatedRequest(
    method: "GET" | "POST",
    path: string,
    options: { query?: Record<string, string | number>; body?: Record<string, unknown> } = {},
  ): Promise<unknown> {
    let token = await this.ensureLogin();
    const response = await this.request(method, path, { ...options, token, commonVersion: 3 });
    if (response.httpStatus === 401) {
      invalidateEvenHubToken();
    }
    return unwrap(response.envelope, response.httpStatus, path);
  }

  private ensureLogin(): Promise<string> {
    const token = getEvenHubToken();
    return token
      ? Promise.resolve(token)
      : Promise.reject(new EvenHubAuthenticationError("Enter your Even account email and password."));
  }

  private async login(email: string, password: string, remember: boolean): Promise<string> {
    try {
      const response = await this.request("POST", "/v2/g/login", {
        commonVersion: 1,
        body: { email: email.trim(), passwd: password },
      });
      const data = asRecord(unwrap(response.envelope, response.httpStatus, "/v2/g/login"));
      const token = typeof data.token === "string" ? data.token : "";
      if (!token) throw new Error("Even login succeeded without returning a session token.");
      saveEvenHubSession(email, token, remember);
      return token;
    } catch (error) {
      if (error instanceof EvenHubAuthenticationError) throw error;
      throw new EvenHubAuthenticationError(String((error as Error)?.message ?? error));
    }
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: {
      commonVersion: 1 | 3;
      query?: Record<string, string | number>;
      body?: Record<string, unknown>;
      token?: string;
    },
  ): Promise<{ httpStatus: number; envelope: ApiEnvelope }> {
    const common = buildCommon(options.commonVersion);
    const query = encodePairs(options.query ?? {});
    const body = options.body ? JSON.stringify(options.body) : "";
    const token = options.token ?? "";
    const headers: Record<string, string> = {
      common,
      sign: hmacSign(signingParts(method, path, common, query, token, body)),
      "Content-Type": "application/json",
    };
    if (token) headers.token = token;
    const response = await fetchWithTimeout(`${API_HOST}${path}${query ? `?${query}` : ""}`, {
      method,
      headers,
      body: body || undefined,
    });
    let envelope: ApiEnvelope = {};
    try {
      envelope = (await response.json()) as ApiEnvelope;
    } catch {
      // unwrap() below will turn this into a useful status-only error.
    }
    return { httpStatus: response.status, envelope };
  }
}

export const evenHubApi = new EvenHubApiClient();

/** Exported for deterministic unit/probe comparison without exposing secrets. */
export function signingParts(
  method: string,
  path: string,
  common: string,
  query = "",
  token = "",
  body = "",
): string {
  const parts = [method.toUpperCase(), path, common];
  if (query) parts.push(normalizeQuery(query));
  if (token) parts.push(token);
  if (body) parts.push(body);
  return parts.sort().join("\n");
}

function buildCommon(version: 1 | 3): string {
  const fields: Record<string, string | number> = {
    platform: "16",
    package: "com.even.sg",
    versionName: "2.2.6",
    build: "114",
    brand: "Google",
    model: "Pixel 7a",
    osVersion: "16",
    carrier: "",
    mcc: "310",
    mnc: "260",
    buildTime: "26060821",
    appId: "1001",
    v: version,
    // This is Android's app-scoped SSAID. Even's login endpoint registers a
    // previously unseen value as a terminal, so Faceclaw does not need the
    // official Even app's differently-scoped ID.
    openUdid: getPhoneOpenUdid(),
    os: "1",
    sn: "",
    verL: "",
    verR: "",
    ringSn: "",
    ringVer: "",
    channel: "googlePlay",
    sttLanguage: "",
    sysLanguage: "US",
    ts: new Date().toISOString(),
    language: "en",
    tzName: "America/Los_Angeles",
    dateFmt: "yyyy/MM/dd",
    timeFmt: "24",
    unit: "metrics",
    region: "US",
  };
  // `common` field order matches the official client; unlike queries it must
  // not be sorted because the raw serialized value participates in signing.
  return Object.entries(fields).map(([key, value]) => `${formEncode(key)}=${formEncode(String(value))}`).join("&");
}

function encodePairs(values: Record<string, string | number>): string {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${formEncode(key)}=${formEncode(String(value))}`)
    .join("&");
}

function normalizeQuery(query: string): string {
  return query
    .split("&")
    .filter(Boolean)
    .sort((a, b) => a.split("=", 1)[0]!.localeCompare(b.split("=", 1)[0]!))
    .join("&");
}

function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function hmacSign(message: string): string {
  if (!global.isAndroid) throw new Error("The EvenHub storefront is currently available only on Android.");
  const charset = java.nio.charset.StandardCharsets.UTF_8;
  const key = new javax.crypto.spec.SecretKeySpec(new java.lang.String(SIGN_KEY).getBytes(charset), "HmacSHA256");
  const mac = javax.crypto.Mac.getInstance("HmacSHA256");
  mac.init(key);
  const digest = mac.doFinal(new java.lang.String(message).getBytes(charset));
  return String(android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("EvenHub request timed out.")), timeoutMs);
  });
  try {
    return await Promise.race([fetchWithUserAgent(url, init), timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function unwrap(envelope: ApiEnvelope, httpStatus: number, path: string): unknown {
  if (httpStatus === 401) {
    throw new EvenHubAuthenticationError("Even rejected the login session.");
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`EvenHub request failed (HTTP ${httpStatus}, ${path}).`);
  }
  if (envelope.code !== 0) {
    const detail = typeof envelope.msg === "string" && envelope.msg ? `: ${envelope.msg}` : "";
    throw new Error(`EvenHub API error ${envelope.code ?? "unknown"}${detail}`);
  }
  return envelope.data;
}

/** Return this installation's Android ID, which Even calls `openUdid`. */
export function getPhoneOpenUdid(): string {
  if (!global.isAndroid) throw new Error("The EvenHub storefront is currently available only on Android.");
  const resolver = Application.android.context?.getContentResolver();
  const openUdid = resolver
    ? String(android.provider.Settings.Secure.getString(resolver, android.provider.Settings.Secure.ANDROID_ID) ?? "")
    : "";
  if (!openUdid) throw new Error("Android did not provide a device ID for EvenHub authentication.");
  return openUdid;
}

function parseStoreApp(value: unknown): EvenHubStoreApp | null {
  const item = asRecord(value);
  const version = asRecord(item.version);
  const packageId = stringValue(item.package_id);
  if (!packageId) return null;
  return {
    id: finiteNumber(item.id),
    packageId,
    name: stringValue(item.name) || packageId,
    creatorName: stringValue(item.creator_name),
    tagline: stringValue(item.tagline),
    description: stringValue(item.description),
    categories: Array.isArray(item.category) ? item.category.map(stringValue).filter(Boolean) : [],
    installCount: finiteNumber(item.install_count),
    likeCount: finiteNumber(item.like_count),
    firstPublishedAt: stringValue(item.first_published_at || item.created_at),
    iconPath: stringValue(item.icon),
    version: stringValue(version.version || item.latest_version),
    changelog: stringValue(version.changelog),
    fileSize: finiteNumber(version.file_size),
  };
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function resolvePrivacyPolicyUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return "";
  const candidate = value.trim();
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    // Even stores uploaded policies as public-CDN-relative paths, just like
    // app icons. Keep relative resolution constrained to that CDN namespace.
    const cleanPath = candidate.replace(/^\/+/, "");
    if (
      !/^prod\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/i.test(cleanPath)
      || cleanPath.includes("..")
      || candidate.startsWith("//")
      || candidate.includes("\\")
    ) {
      return "";
    }
    return `${PUBLIC_CDN_HOST}/${cleanPath}`;
  }
}
