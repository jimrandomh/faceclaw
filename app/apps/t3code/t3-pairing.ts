/**
 * Pairing-link parsing for T3 Code environments, mirroring T3's own
 * resolveRemotePairingTarget (packages/shared/src/remote.ts) without URL /
 * URLSearchParams (the NativeScript runtime's URLSearchParams is unreliable).
 *
 * Accepted forms:
 * - direct link from `t3 serve` / `t3 pair`: http://192.168.1.20:3773/pair#token=7JBMA3AYC28V
 *   (the token may also be a ?token= query param)
 * - hosted link: https://app.t3.codes/pair?host=<backend url>&label=...#token=...
 * - T3 mobile QR payload: t3code://...?pairingUrl=<url-encoded pairing link>
 * - "<host[:port]> <code>" typed by hand (http for IP literals and localhost,
 *   https otherwise, like T3's mobile app)
 */

export type PairingTarget = {
  /** One-time pairing credential (12 characters from `t3 pair`). */
  credential: string;
  /** Backend origin with a trailing slash, e.g. "http://192.168.1.20:3773/". */
  httpBaseUrl: string;
  /** The same origin as ws:// or wss://. */
  wsBaseUrl: string;
  /** Label from a hosted link, if any. */
  label: string;
};

export type PairingParseResult = { ok: true; target: PairingTarget } | { ok: false; error: string };

type ParsedUrl = {
  scheme: string;
  /** host[:port], brackets kept for IPv6. */
  authority: string;
  query: Map<string, string>;
  fragment: Map<string, string>;
};

const URL_PATTERN = /^([a-zA-Z][a-zA-Z\d+.-]*):\/\/([^/?#\s]*)([^?#\s]*)(?:\?([^#\s]*))?(?:#(\S*))?$/;

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function parseParams(text: string | undefined): Map<string, string> {
  const params = new Map<string, string>();
  if (!text) return params;
  for (const part of text.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decodeComponent(eq < 0 ? part : part.slice(0, eq));
    const value = eq < 0 ? "" : decodeComponent(part.slice(eq + 1));
    if (!params.has(key)) params.set(key, value);
  }
  return params;
}

function parseUrl(text: string): ParsedUrl | null {
  const match = URL_PATTERN.exec(text.trim());
  if (!match) return null;
  // Drop any userinfo; T3 links never carry it.
  const authority = match[2]!.replace(/^.*@/, "");
  if (!authority) return null;
  return {
    scheme: match[1]!.toLowerCase(),
    authority,
    query: parseParams(match[4]),
    fragment: parseParams(match[5]),
  };
}

/** Lower-case the host (not the port) and drop default ports, like URL does. */
function normalizeAuthority(scheme: "http" | "https", authority: string): string {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  if (!match) return authority.toLowerCase();
  const host = match[1]!.toLowerCase();
  const port = match[2];
  if (!port || (scheme === "http" && port === "80") || (scheme === "https" && port === "443")) return host;
  return `${host}:${port}`;
}

function bases(scheme: string, authority: string): { httpBaseUrl: string; wsBaseUrl: string } | null {
  const httpScheme = scheme === "ws" ? "http" : scheme === "wss" ? "https" : scheme;
  if (httpScheme !== "http" && httpScheme !== "https") return null;
  const normalized = normalizeAuthority(httpScheme, authority);
  return {
    httpBaseUrl: `${httpScheme}://${normalized}/`,
    wsBaseUrl: `${httpScheme === "https" ? "wss" : "ws"}://${normalized}/`,
  };
}

function isIpLiteralOrLocal(host: string): boolean {
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (hostname.includes(":")) return true;
  if (hostname.toLowerCase() === "localhost") return true;
  const octets = hostname.split(".");
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/** The backend named by a hosted link's host param, which may omit its scheme. */
function hostedBackend(host: string): { httpBaseUrl: string; wsBaseUrl: string } | null {
  const trimmed = host.trim().replace(/^\/+/, "");
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = parseUrl(withScheme);
  return parsed ? bases(parsed.scheme, parsed.authority) : null;
}

const NOT_A_LINK = "Paste the pairing link from `t3 pair` (it looks like http://<host>:<port>/pair#token=...).";

export function parsePairingInput(input: string): PairingParseResult {
  let text = input.trim();
  if (!text) return { ok: false, error: NOT_A_LINK };

  // T3 mobile's QR payload wraps the real pairing link.
  const wrapped = parseUrl(text);
  if (wrapped?.scheme === "t3code") {
    const inner = wrapped.query.get("pairingUrl")?.trim();
    if (!inner) return { ok: false, error: "That t3code:// link has no pairing URL in it." };
    text = inner;
  }

  // "host[:port] CODE" typed by hand.
  const pair = /^(\S+)\s+([A-Za-z0-9]{6,})$/.exec(text);
  if (pair && !pair[1]!.includes("#")) {
    const hostText = pair[1]!;
    const withScheme = hostText.includes("://") ? hostText : `${isIpLiteralOrLocal(hostText) ? "http" : "https"}://${hostText}`;
    const parsed = parseUrl(withScheme);
    const resolved = parsed && bases(parsed.scheme, parsed.authority);
    if (!resolved) return { ok: false, error: NOT_A_LINK };
    return { ok: true, target: { credential: pair[2]!, label: "", ...resolved } };
  }

  const url = parseUrl(text);
  if (!url) return { ok: false, error: NOT_A_LINK };
  if (!["http", "https", "ws", "wss"].includes(url.scheme)) {
    return { ok: false, error: `Unsupported link type "${url.scheme}:".` };
  }
  const token = (url.fragment.get("token") || url.query.get("token") || "").trim();
  const hostParam = url.query.get("host")?.trim() ?? "";
  if (hostParam && token) {
    const backend = hostedBackend(hostParam);
    if (!backend) return { ok: false, error: `Can't read the server address "${hostParam}" in that link.` };
    return { ok: true, target: { credential: token, label: url.query.get("label")?.trim() ?? "", ...backend } };
  }
  if (!token) {
    return { ok: false, error: "That link has no pairing token. Run `t3 pair` on the server for a fresh link." };
  }
  const resolved = bases(url.scheme, url.authority);
  if (!resolved) return { ok: false, error: NOT_A_LINK };
  return { ok: true, target: { credential: token, label: "", ...resolved } };
}

/** "host:port" for display (never includes credentials). */
export function baseUrlLabel(httpBaseUrl: string): string {
  return httpBaseUrl.replace(/^[a-z]+:\/\//, "").replace(/\/$/, "");
}
