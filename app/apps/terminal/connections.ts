import { getStringSetting, setStringSetting } from "../../native/settings-store";

/**
 * Terminal-app connection registry: the g2mirror hosts the app knows about,
 * stored as JSON under one settings key so every isolate sees the same list
 * and change notifications ride the ordinary settings-store channel.
 *
 * A connection is entered as a g2mirror:// connection string (the same form
 * g2mirror-view accepts): g2mirror://<token>@<host>[:port] for plain
 * websockets (default port 8737), g2mirrors://... for TLS (default 443).
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

/** The host[:port] part of a connection string; "" if it doesn't parse. */
export function connectionStringHostLabel(url: string): string {
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
