import { getStringSetting, setStringSetting } from "./settings-store";
import { buildQuery, SpotifyApiError, SpotifyClient, type SpotifyFetch, type SpotifyTokenSource } from "./spotify-web-api";

/**
 * Spotify sign-in: OAuth authorization code with PKCE against the user's own
 * client ID (no client secret), redirected to a loopback address that the
 * phone catches (FaceclawWebSignIn on iOS). Spotify accepts http only for
 * loopback IP literals, and custom-scheme redirects fail with "insecure
 * redirect URI" for apps created since 2025, so the redirect is
 * http://127.0.0.1 on a fixed port the user registers in the dashboard.
 *
 * The tokens are stored with the client ID they were issued to; changing the
 * client ID setting signs out.
 */

export const SPOTIFY_ACCOUNTS_BASE = "https://accounts.spotify.com";
export const SPOTIFY_REDIRECT_PORT = 43823;
export const SPOTIFY_REDIRECT_PATH = "/spotify-callback";
export const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}${SPOTIFY_REDIRECT_PATH}`;
export const SPOTIFY_DASHBOARD_URL = "https://developer.spotify.com/dashboard";

export const SPOTIFY_CLIENT_ID_KEY = "music.spotify.clientId";
export const SPOTIFY_ACCOUNT_KEY = "music.spotify.account";

export const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "user-library-modify",
  "user-follow-read",
];

/** Refresh this long before Spotify's stated expiry (an hour), so a token never lapses mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

export type SpotifyAccount = {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAtMs: number;
  userId: string;
  displayName: string;
  /** "premium", "free", ...; playback control needs premium. */
  product: string;
};

export type SpotifyTokens = { accessToken: string; refreshToken: string; expiresAtMs: number };

/** The phone side of a sign-in: PKCE material and the browser sheet that catches the loopback redirect. */
export type WebSignIn = {
  /** A fresh PKCE verifier and its S256 challenge. */
  createPkce(): { verifier: string; challenge: string };
  randomState(): string;
  /** Show the provider's page; resolves to the redirect URL, rejects with "cancelled" or why it failed. */
  open(authorizeUrl: string, port: number, path: string): Promise<string>;
  cancel(): void;
};

export function spotifyClientId(): string {
  return getStringSetting(SPOTIFY_CLIENT_ID_KEY, "").trim();
}

export function isValidSpotifyClientId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value.trim());
}

/** The stored sign-in, or null when signed out or signed in with another client ID. */
export function readSpotifyAccount(): SpotifyAccount | null {
  let raw: any;
  try {
    raw = JSON.parse(getStringSetting(SPOTIFY_ACCOUNT_KEY, "") || "null");
  } catch {
    return null;
  }
  if (!raw || typeof raw.refreshToken !== "string" || !raw.refreshToken) return null;
  const clientId = spotifyClientId();
  if (!clientId || raw.clientId !== clientId) return null;
  return {
    clientId,
    accessToken: String(raw.accessToken ?? ""),
    refreshToken: raw.refreshToken,
    expiresAtMs: Number(raw.expiresAtMs) || 0,
    userId: String(raw.userId ?? ""),
    displayName: String(raw.displayName ?? ""),
    product: String(raw.product ?? ""),
  };
}

export function saveSpotifyAccount(account: SpotifyAccount | null): void {
  setStringSetting(SPOTIFY_ACCOUNT_KEY, account ? JSON.stringify(account) : "");
}

export function spotifyAuthorizeUrl(clientId: string, codeChallenge: string, state: string): string {
  return `${SPOTIFY_ACCOUNTS_BASE}/authorize${buildQuery({
    response_type: "code",
    client_id: clientId,
    scope: SPOTIFY_SCOPES.join(" "),
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
  })}`;
}

/** The authorization code from Spotify's redirect; throws with a message for the glasses otherwise. */
export function parseSpotifyRedirect(url: string, expectedState: string): string {
  const params = parseQueryString(url);
  if (params.error) {
    throw new Error(params.error === "access_denied" ? "Spotify sign-in was declined." : `Spotify sign-in failed: ${params.error}`);
  }
  if (params.state !== expectedState) throw new Error("Spotify sign-in failed: the reply didn't match this sign-in. Try again.");
  if (!params.code) throw new Error("Spotify sign-in failed: no authorization code in the reply.");
  return params.code;
}

/** Query parameters of a URL (not URLSearchParams, which the NativeScript runtime mishandles). */
export function parseQueryString(url: string): Record<string, string> {
  const query = url.split("#")[0]!.split("?").slice(1).join("?");
  const params: Record<string, string> = {};
  for (const part of query.split("&")) {
    if (!part) continue;
    const separator = part.indexOf("=");
    const key = separator < 0 ? part : part.slice(0, separator);
    const value = separator < 0 ? "" : part.slice(separator + 1);
    try {
      params[decodeURIComponent(key.replace(/\+/g, " "))] = decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      // Malformed escapes: skip the parameter.
    }
  }
  return params;
}

/** POST to Spotify's token endpoint (authorization_code or refresh_token grant). */
export async function requestSpotifyTokens(
  fetchImpl: SpotifyFetch,
  params: Record<string, string>,
  nowMs: number,
): Promise<SpotifyTokens> {
  let status = 0;
  let body = "";
  try {
    const response = await fetchImpl(`${SPOTIFY_ACCOUNTS_BASE}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: buildQuery(params).slice(1),
    });
    status = response.status;
    body = await response.text();
  } catch (error) {
    throw new SpotifyApiError(`Can't reach Spotify: ${(error as Error)?.message ?? error}`, 0);
  }
  let parsed: any = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Reported below.
  }
  if (status >= 200 && status < 300 && typeof parsed?.access_token === "string") {
    const expiresIn = Number(parsed.expires_in);
    return {
      accessToken: parsed.access_token,
      // Spotify may rotate the refresh token; "" keeps the current one.
      refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : "",
      expiresAtMs: nowMs + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    };
  }
  const error = typeof parsed?.error === "string" ? parsed.error : "";
  const description = typeof parsed?.error_description === "string" ? parsed.error_description : "";
  if (error === "invalid_grant" && params.grant_type === "refresh_token") {
    throw new SpotifyApiError("Spotify no longer accepts this sign-in. Sign in again from the Music app menu.", status, error);
  }
  if (error === "invalid_client") {
    throw new SpotifyApiError("Spotify doesn't recognize the client ID. Check it under Spotify in the Music app menu.", status, error);
  }
  throw new SpotifyApiError(`Spotify sign-in failed: ${description || error || `HTTP ${status}`}`, status, error);
}

/**
 * Access tokens for the stored account: the current one until it nears
 * expiry, then one refresh shared by every caller waiting on it. A refresh
 * Spotify rejects (revoked access) signs out.
 */
export class SpotifySession implements SpotifyTokenSource {
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly fetchImpl: SpotifyFetch,
    private readonly now: () => number = Date.now,
  ) {}

  accessToken(forceRefresh: boolean): Promise<string> {
    const account = readSpotifyAccount();
    if (!account) return Promise.reject(new SpotifyApiError("Not signed in to Spotify.", 401, "signed_out"));
    if (!forceRefresh && account.accessToken && account.expiresAtMs - EXPIRY_MARGIN_MS > this.now()) {
      return Promise.resolve(account.accessToken);
    }
    this.refreshing ??= this.refresh(account).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(account: SpotifyAccount): Promise<string> {
    let tokens: SpotifyTokens;
    try {
      tokens = await requestSpotifyTokens(this.fetchImpl, {
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
        client_id: account.clientId,
      }, this.now());
    } catch (error) {
      if (error instanceof SpotifyApiError && error.reason === "invalid_grant" && readSpotifyAccount()?.refreshToken === account.refreshToken) {
        saveSpotifyAccount(null);
      }
      throw error;
    }
    // A sign-out or another sign-in while this was in flight wins.
    if (readSpotifyAccount()?.refreshToken !== account.refreshToken) {
      throw new SpotifyApiError("Spotify sign-in changed; try again.", 401, "signed_out");
    }
    saveSpotifyAccount({
      ...account,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || account.refreshToken,
      expiresAtMs: tokens.expiresAtMs,
    });
    return tokens.accessToken;
  }
}

/**
 * The whole sign-in: the browser sheet, the code exchange and the profile
 * lookup; stores and returns the account. Rejects with "cancelled" when the
 * user closes the sheet.
 */
export async function signInToSpotify(
  fetchImpl: SpotifyFetch,
  webSignIn: WebSignIn,
  now: () => number = Date.now,
): Promise<SpotifyAccount> {
  const clientId = spotifyClientId();
  if (!isValidSpotifyClientId(clientId)) throw new Error("Enter your Spotify client ID first.");
  const { verifier, challenge } = webSignIn.createPkce();
  const state = webSignIn.randomState();
  const redirect = await webSignIn.open(spotifyAuthorizeUrl(clientId, challenge, state), SPOTIFY_REDIRECT_PORT, SPOTIFY_REDIRECT_PATH);
  const code = parseSpotifyRedirect(redirect, state);
  const tokens = await requestSpotifyTokens(fetchImpl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  }, now());
  const user = await new SpotifyClient(fetchImpl, { accessToken: async () => tokens.accessToken }).me();
  const account: SpotifyAccount = {
    clientId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAtMs: tokens.expiresAtMs,
    userId: user.id,
    displayName: user.displayName,
    product: user.product,
  };
  if (!account.refreshToken) throw new Error("Spotify sign-in failed: no refresh token in the reply.");
  saveSpotifyAccount(account);
  return account;
}
