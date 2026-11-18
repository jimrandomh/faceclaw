import { getStringSetting, setStringSetting } from "../../native/settings-store";

/**
 * Terminal-app connection registry: the hosts the app knows about, stored as
 * JSON under one settings key so every isolate sees the same list and change
 * notifications ride the ordinary settings-store channel.
 *
 * A connection is entered as a connection string:
 * - g2mirror://<token>@<host>[:port]: a g2mirror server reached directly
 *   (the same form g2mirror-view accepts) over a plain websocket (default
 *   port 8737); g2mirrors://... for TLS (default 443).
 * - ssh://<user>@<host>[:port]: tmux on an SSH host (default port 22).
 * - ssh://<user>@<host>[:port]?g2mirror=<token>[@<host>[:port]]: a g2mirror
 *   server tunnelled over SSH; the address after the token is where the
 *   server listens as seen from the SSH host (default 127.0.0.1:8737).
 * SSH connections pin the host's key (hostKeys, trusted on first connection
 * after the user checks its fingerprint); their passwords live in the
 * platform keystore (app/native/ssh), not here.
 */

export const TERMINAL_CONNECTIONS_KEY = "terminal.connections";

export type TerminalConnection = {
  /** Stable id, assigned at add time; windows and clients key off this. */
  id: string;
  /** The g2mirror:// connection string as entered. */
  url: string;
  /**
   * server_name from the last successful init handshake; null before the
   * first success. Display name falls back to the connection string's
   * host[:port] (never the token).
   */
  serverName: string | null;
  /** Auto-connect while the Terminal app is open. Toggled by Connect/Disconnect. */
  enabled: boolean;
  /** SSH connections: trusted host keys (SSH wire format, base64). */
  hostKeys: string[];
};

export type ParsedConnectionString = {
  secure: boolean;
  host: string;
  port: number;
  authToken: string;
};

/**
 * Parse a g2mirror://token@host[:port] connection string (g2mirrors:// for
 * TLS). Returns null if the string doesn't have that shape.
 */
export function parseConnectionString(url: string): ParsedConnectionString | null {
  const match = /^(g2mirrors?):\/\/([^@\s/]+)@(\[[^\]\s]+\]|[^:/@\s]+)(?::(\d+))?\/?$/.exec(url.trim());
  if (!match) return null;
  const secure = match[1] === "g2mirrors";
  let authToken = match[2]!;
  try {
    authToken = decodeURIComponent(authToken);
  } catch {
    // Not valid percent-encoding; use the raw token.
  }
  const host = match[3]!;
  const port = match[4] ? parseInt(match[4], 10) : secure ? 443 : 8737;
  if (!(port >= 1 && port <= 65535)) return null;
  return { secure, host, port, authToken };
}

export type ParsedSshConnection = {
  user: string;
  host: string;
  port: number;
} & (
  | { mode: "tmux" }
  | {
      mode: "g2mirror";
      authToken: string;
      /** Where g2mirror-server listens, from the SSH host's point of view. */
      targetHost: string;
      targetPort: number;
    }
);

function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Parse an ssh://user@host[:port][?g2mirror=token[@host[:port]]] string; null if malformed. */
export function parseSshConnectionString(url: string): ParsedSshConnection | null {
  const match = /^ssh:\/\/([^@\s/?]+)@(\[[^\]\s]+\]|[^:/@\s?]+)(?::(\d+))?\/?(?:\?(.*))?$/.exec(url.trim());
  if (!match) return null;
  const user = decodeComponent(match[1]!);
  const host = match[2]!.replace(/^\[(.*)\]$/, "$1");
  const port = match[3] ? parseInt(match[3], 10) : 22;
  if (!user || !(port >= 1 && port <= 65535)) return null;
  const params = new Map<string, string>();
  for (const part of (match[4] ?? "").split("&").filter(Boolean)) {
    const equals = part.indexOf("=");
    if (equals < 0) return null;
    params.set(part.slice(0, equals), decodeComponent(part.slice(equals + 1)));
  }
  for (const key of params.keys()) {
    if (key !== "g2mirror") return null;
  }
  const g2mirror = params.get("g2mirror");
  if (g2mirror === undefined) return { user, host, port, mode: "tmux" };
  // token[@host[:port]], split at the last "@" so the token may contain one.
  const at = g2mirror.lastIndexOf("@");
  const authToken = at < 0 ? g2mirror : g2mirror.slice(0, at);
  const target = at < 0 ? "" : g2mirror.slice(at + 1);
  const targetMatch = /^(\[[^\]\s]+\]|[^:\s]*)(?::(\d+))?$/.exec(target);
  if (!authToken || !targetMatch) return null;
  const targetHost = targetMatch[1] || "127.0.0.1";
  const targetPort = targetMatch[2] ? parseInt(targetMatch[2], 10) : 8737;
  if (!(targetPort >= 1 && targetPort <= 65535)) return null;
  return { user, host, port, mode: "g2mirror", authToken, targetHost, targetPort };
}

export type ParsedAnyConnection =
  | ({ kind: "g2mirror" } & ParsedConnectionString)
  | ({ kind: "ssh" } & ParsedSshConnection);

/** Parse any supported connection string; null if it's none of them. */
export function parseAnyConnectionString(url: string): ParsedAnyConnection | null {
  const direct = parseConnectionString(url);
  if (direct) return { kind: "g2mirror", ...direct };
  const ssh = parseSshConnectionString(url);
  return ssh ? { kind: "ssh", ...ssh } : null;
}

/** The [user@]host[:port] part of a connection string (never a token); "" if it doesn't parse. */
export function connectionStringHostLabel(url: string): string {
  const ssh = parseSshConnectionString(url);
  if (ssh) {
    const host = ssh.host.includes(":") ? `[${ssh.host}]` : ssh.host;
    return `${ssh.user}@${host}${ssh.port === 22 ? "" : `:${ssh.port}`}`;
  }
  const parsed = parseConnectionString(url);
  if (!parsed) return "";
  const defaultPort = parsed.secure ? 443 : 8737;
  return parsed.port === defaultPort ? parsed.host : `${parsed.host}:${parsed.port}`;
}

/** Human label for a connection: cached server name, else its host[:port]. */
export function connectionDisplayName(connection: TerminalConnection): string {
  return connection.serverName || connectionStringHostLabel(connection.url) || connection.url;
}

export function loadConnections(): TerminalConnection[] {
  const raw = getStringSetting(TERMINAL_CONNECTIONS_KEY, "");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: any): TerminalConnection => ({
        id: String(item?.id ?? ""),
        url: String(item?.url ?? ""),
        serverName: typeof item?.serverName === "string" && item.serverName ? item.serverName : null,
        enabled: item?.enabled !== false,
        hostKeys: Array.isArray(item?.hostKeys) ? item.hostKeys.filter((key: unknown) => typeof key === "string") : [],
      }))
      .filter((connection) => connection.id.length > 0 && connection.url.length > 0);
  } catch {
    return [];
  }
}

export function saveConnections(connections: TerminalConnection[]): void {
  setStringSetting(TERMINAL_CONNECTIONS_KEY, JSON.stringify(connections));
}

/** Apply `update` to the stored connection with this id (no-op if gone). */
export function updateConnection(id: string, update: Partial<Omit<TerminalConnection, "id">>): void {
  const connections = loadConnections();
  const connection = connections.find((candidate) => candidate.id === id);
  if (!connection) return;
  Object.assign(connection, update);
  saveConnections(connections);
}
