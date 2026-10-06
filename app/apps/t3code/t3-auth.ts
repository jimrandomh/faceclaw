/**
 * HTTP half of connecting to a T3 Code environment: the unauthenticated
 * environment descriptor, the one-time pairing-token exchange (RFC 8693, form
 * encoded), and short-lived WebSocket tickets.
 *
 * Direct pairings use a plain Bearer token: 30 days, no refresh. When it
 * expires (or is revoked) the ticket request fails with 401 and the user has
 * to pair again with a fresh `t3 pair` link.
 */

/** The orchestration protocol this client speaks (the server answers 426 to any other). */
export const T3_ORCHESTRATION_PROTOCOL = 2;

/** What every ordinary pairing grants; asking for a scope the link doesn't grant burns the token. */
const STANDARD_SCOPES = "orchestration:read orchestration:operate terminal:operate review:write relay:read";

const HTTP_TIMEOUT_MS = 12_000;

/** The subset of fetch these calls need, so tests and Node scripts can pass their own. */
export type T3Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export type EnvironmentDescriptor = {
  environmentId: string;
  label: string;
  serverVersion: string;
  orchestrationProtocolVersion: number;
  capabilities: Record<string, unknown>;
};

export type PairedCredential = {
  accessToken: string;
  /** Epoch ms. */
  expiresAtMs: number;
};

/** An HTTP failure; `authFailed` means the stored token is no good (re-pair). */
export class T3HttpError extends Error {
  constructor(message: string, readonly status: number, readonly authFailed = false) {
    super(message);
    this.name = "T3HttpError";
  }
}

/** Form/query encoding (not URLSearchParams, which the NativeScript runtime mishandles). */
function buildQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key]!)}`)
    .join("&");
}

async function request(
  fetchImpl: T3Fetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; ok: boolean; body: string }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new T3HttpError("Timed out reaching the server.", 0)), HTTP_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([fetchImpl(url, init), timeout]);
    const body = await Promise.race([response.text(), timeout]);
    return { status: response.status, ok: response.ok, body };
  } catch (error) {
    if (error instanceof T3HttpError) throw error;
    throw new T3HttpError(`Can't reach the server: ${(error as Error)?.message ?? error}`, 0);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseJson(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Human message for T3's error envelope ({_tag, code, reason, traceId}). */
function describeFailure(status: number, body: string, what: string): string {
  const parsed = parseJson(body);
  const reason = typeof parsed?.reason === "string" ? parsed.reason : typeof parsed?.code === "string" ? parsed.code : "";
  switch (reason) {
    case "invalid_credential":
      return what === "pair"
        ? "That pairing link was already used or has expired. Run `t3 pair` for a new one."
        : "The server no longer accepts this device's sign-in. Pair it again.";
    case "missing_credential":
      return "The server asked for a sign-in. Pair this device again.";
    case "scope_not_granted":
      return "That pairing link doesn't grant enough access. Run `t3 pair` for a new one.";
  }
  if (status === 426 || parsed?.code === "orchestration_protocol_incompatible") {
    return "This T3 Code server speaks a different protocol version. Update T3 Code and Faceclaw.";
  }
  return `Server error (HTTP ${status}${reason ? `, ${reason}` : ""}).`;
}

export async function fetchEnvironmentDescriptor(fetchImpl: T3Fetch, httpBaseUrl: string): Promise<EnvironmentDescriptor> {
  const response = await request(fetchImpl, `${httpBaseUrl}.well-known/t3/environment`, { method: "GET", headers: {} });
  const parsed = parseJson(response.body);
  if (!response.ok || !parsed || typeof parsed.environmentId !== "string") {
    throw new T3HttpError(
      response.ok ? "That address doesn't look like a T3 Code server." : describeFailure(response.status, response.body, "descriptor"),
      response.status,
    );
  }
  return {
    environmentId: parsed.environmentId,
    label: typeof parsed.label === "string" ? parsed.label : "",
    serverVersion: typeof parsed.serverVersion === "string" ? parsed.serverVersion : "",
    orchestrationProtocolVersion: typeof parsed.orchestrationProtocolVersion === "number" ? parsed.orchestrationProtocolVersion : 1,
    capabilities: parsed.capabilities && typeof parsed.capabilities === "object" ? parsed.capabilities : {},
  };
}

/** Trade a one-time pairing credential for a durable bearer token. */
export async function exchangePairingCredential(
  fetchImpl: T3Fetch,
  httpBaseUrl: string,
  credential: string,
  client: { label: string; os: string },
): Promise<PairedCredential> {
  const body = buildQuery({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: STANDARD_SCOPES,
    client_label: client.label,
    client_device_type: "mobile",
    client_os: client.os,
  });
  const response = await request(fetchImpl, `${httpBaseUrl}oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const parsed = parseJson(response.body);
  if (!response.ok || typeof parsed?.access_token !== "string") {
    throw new T3HttpError(describeFailure(response.status, response.body, "pair"), response.status, response.status === 401);
  }
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 30 * 24 * 3600;
  return { accessToken: parsed.access_token, expiresAtMs: Date.now() + expiresIn * 1000 };
}

/** A WebSocket ticket (valid ~5 minutes); fetch a fresh one for every connect. */
export async function fetchWebSocketTicket(fetchImpl: T3Fetch, httpBaseUrl: string, accessToken: string): Promise<string> {
  const response = await request(fetchImpl, `${httpBaseUrl}api/auth/websocket-ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const parsed = parseJson(response.body);
  if (!response.ok || typeof parsed?.ticket !== "string") {
    throw new T3HttpError(describeFailure(response.status, response.body, "ticket"), response.status, response.status === 401);
  }
  return parsed.ticket;
}

/** The /ws URL for a ticket. */
export function webSocketUrl(wsBaseUrl: string, ticket: string, clientOs: string): string {
  return `${wsBaseUrl}ws?${buildQuery({
    wsTicket: ticket,
    clientSurface: "mobile",
    clientDeviceType: "phone",
    clientOs,
    connectionMethod: "direct",
    orchestrationProtocol: String(T3_ORCHESTRATION_PROTOCOL),
  })}`;
}
