/**
 * Spotify Web API over HTTPS with the signed-in user's token: the player
 * (what is playing on any of the user's Spotify Connect devices, and control
 * of it), the user's library, and search, normalized into the small shapes
 * the Music app uses. No NativeScript imports, so the Node tests drive it with
 * a fake fetch.
 *
 * Every personal client ID is a development-mode app, which since February
 * 2026 means: the client ID's owner needs Premium, playback control needs
 * Premium, at most five allowlisted users, only owned or collaborative
 * playlists list their items, no batch lookups, and search and artist albums
 * return at most 10 results per page.
 */

export const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

const HTTP_TIMEOUT_MS = 12_000;
/** The most a library listing gathers (a page is 50); enough to scroll through on the glasses. */
const MAX_LIST_ITEMS = 500;

/** The subset of fetch this client needs (fetchTextWithUserAgent in the app). */
export type SpotifyFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Hands out a current access token, refreshing it when expired or when forced (after a 401). */
export type SpotifyTokenSource = {
  accessToken(forceRefresh: boolean): Promise<string>;
};

/** A failed request; `reason` is Spotify's player error code (NO_ACTIVE_DEVICE, PREMIUM_REQUIRED, ...). */
export class SpotifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason = "",
  ) {
    super(message);
    this.name = "SpotifyApiError";
  }
}

export type SpotifyImage = { url: string; width: number; height: number };

export type SpotifyItem = {
  uri: string;
  type: "track" | "episode";
  name: string;
  /** Track artists, comma-joined; for an episode, its show. */
  artists: string;
  /** The track's album; for an episode, its show. "" when the API leaves it out (album track listings). */
  album: string;
  durationMs: number;
  images: SpotifyImage[];
};

export type SpotifyDevice = {
  id: string;
  name: string;
  /** "Smartphone", "Computer", "Speaker", ... */
  type: string;
  active: boolean;
  /** Restricted devices accept no Web API commands. */
  restricted: boolean;
  /** -1 when the device reports none. */
  volumePercent: number;
  supportsVolume: boolean;
};

export type SpotifyRepeat = "off" | "context" | "track";

export type SpotifyPlayback = {
  device: SpotifyDevice | null;
  playing: boolean;
  progressMs: number;
  shuffle: boolean;
  repeat: SpotifyRepeat;
  /** The playlist / album / artist playing from; "" for none (a queue of single tracks). */
  contextUri: string;
  /** null during an ad, between items, or for content the API does not describe. */
  item: SpotifyItem | null;
  /** "track", "episode", "ad" or "unknown". */
  playingType: string;
  /** The player actions the context forbids, as Spotify names them: pausing, resuming, skipping_next, ... */
  disallows: string[];
};

export type SpotifyQueue = { current: SpotifyItem | null; upcoming: SpotifyItem[] };

export type SpotifyUser = { id: string; displayName: string; product: string };

export type SpotifyPlaylist = {
  id: string;
  uri: string;
  name: string;
  ownerId: string;
  ownerName: string;
  collaborative: boolean;
  total: number;
};

export type SpotifyAlbum = { id: string; uri: string; name: string; artists: string };

export type SpotifyArtist = { id: string; uri: string; name: string };

/** A played track and the context it played from ("" when none). */
export type SpotifyPlayed = { item: SpotifyItem; contextUri: string };

export type SpotifySearchResults = {
  tracks: SpotifyItem[];
  albums: SpotifyAlbum[];
  artists: SpotifyArtist[];
  playlists: SpotifyPlaylist[];
};

export type SpotifySearchType = "track" | "album" | "artist" | "playlist";

/**
 * What to play: a context (playlist, album, artist, show) optionally starting
 * at one of its items, or a list of track URIs. Empty resumes the current
 * playback.
 */
export type SpotifyPlayRequest = {
  contextUri?: string;
  uris?: string[];
  offsetUri?: string;
  offsetPosition?: number;
};

type Query = Record<string, string | number | boolean | undefined>;

export class SpotifyClient {
  constructor(
    private readonly fetchImpl: SpotifyFetch,
    private readonly tokens: SpotifyTokenSource,
  ) {}

  /** The current playback on whichever device is active; null when nothing is. */
  async playback(): Promise<SpotifyPlayback | null> {
    const raw = await this.request("GET", "/me/player", { query: { additional_types: "episode" } });
    return raw ? parsePlayback(raw) : null;
  }

  async queue(): Promise<SpotifyQueue> {
    const raw = await this.request("GET", "/me/player/queue");
    return {
      current: parseItem(raw?.currently_playing),
      upcoming: asArray(raw?.queue).map(parseItem).filter(isPresent),
    };
  }

  async devices(): Promise<SpotifyDevice[]> {
    const raw = await this.request("GET", "/me/player/devices");
    return asArray(raw?.devices).map(parseDevice).filter(isPresent);
  }

  async play(request: SpotifyPlayRequest = {}, deviceId = ""): Promise<void> {
    const body: Record<string, unknown> = {};
    if (request.contextUri) body.context_uri = request.contextUri;
    if (request.uris?.length) body.uris = request.uris;
    if (request.offsetUri) body.offset = { uri: request.offsetUri };
    else if (request.offsetPosition !== undefined) body.offset = { position: request.offsetPosition };
    await this.request("PUT", "/me/player/play", { query: { device_id: deviceId || undefined }, body });
  }

  async pause(): Promise<void> {
    await this.request("PUT", "/me/player/pause");
  }

  async next(): Promise<void> {
    await this.request("POST", "/me/player/next");
  }

  async previous(): Promise<void> {
    await this.request("POST", "/me/player/previous");
  }

  async setShuffle(on: boolean): Promise<void> {
    await this.request("PUT", "/me/player/shuffle", { query: { state: on } });
  }

  async setRepeat(mode: SpotifyRepeat): Promise<void> {
    await this.request("PUT", "/me/player/repeat", { query: { state: mode } });
  }

  async setVolume(percent: number, deviceId = ""): Promise<void> {
    const volume = Math.max(0, Math.min(100, Math.round(percent)));
    await this.request("PUT", "/me/player/volume", { query: { volume_percent: volume, device_id: deviceId || undefined } });
  }

  /** Move playback to a device (one that shows in devices() but is not active), optionally playing. */
  async transfer(deviceId: string, play: boolean): Promise<void> {
    await this.request("PUT", "/me/player", { body: { device_ids: [deviceId], play } });
  }

  async me(): Promise<SpotifyUser> {
    const raw = await this.request("GET", "/me");
    return { id: str(raw?.id), displayName: str(raw?.display_name) || str(raw?.id), product: str(raw?.product) };
  }

  /** Whether each URI is in the user's library (Liked Songs for tracks). */
  async libraryContains(uris: string[]): Promise<boolean[]> {
    const raw = await this.request("GET", "/me/library/contains", { query: { uris: uris.join(",") } });
    return asArray(raw).map(Boolean);
  }

  async saveToLibrary(uris: string[]): Promise<void> {
    await this.request("PUT", "/me/library", { query: { uris: uris.join(",") } });
  }

  async removeFromLibrary(uris: string[]): Promise<void> {
    await this.request("DELETE", "/me/library", { query: { uris: uris.join(",") } });
  }

  playlists(): Promise<SpotifyPlaylist[]> {
    return this.collect("/me/playlists", { limit: 50 }, (raw) => asArray(raw?.items).map(parsePlaylist));
  }

  /** Only playlists the user owns or collaborates on list their items (403 otherwise). */
  playlistItems(playlistId: string): Promise<SpotifyItem[]> {
    return this.collect(`/playlists/${encodeURIComponent(playlistId)}/items`, { limit: 50, additional_types: "track,episode" },
      (raw) => asArray(raw?.items).map((entry: any) => parseItem(entry?.item ?? entry?.track)));
  }

  savedTracks(): Promise<SpotifyItem[]> {
    return this.collect("/me/tracks", { limit: 50 }, (raw) => asArray(raw?.items).map((entry: any) => parseItem(entry?.track)));
  }

  savedAlbums(): Promise<SpotifyAlbum[]> {
    return this.collect("/me/albums", { limit: 50 }, (raw) => asArray(raw?.items).map((entry: any) => parseAlbum(entry?.album)));
  }

  albumTracks(albumId: string): Promise<SpotifyItem[]> {
    return this.collect(`/albums/${encodeURIComponent(albumId)}/tracks`, { limit: 50 }, (raw) => asArray(raw?.items).map(parseItem));
  }

  followedArtists(): Promise<SpotifyArtist[]> {
    // Cursor-paged, with the page wrapped in an "artists" object.
    return this.collect("/me/following", { type: "artist", limit: 50 }, (raw) => asArray(raw?.artists?.items).map(parseArtist),
      (raw) => str(raw?.artists?.next));
  }

  artistAlbums(artistId: string): Promise<SpotifyAlbum[]> {
    return this.collect(`/artists/${encodeURIComponent(artistId)}/albums`, { include_groups: "album,single,compilation", limit: 10 },
      (raw) => asArray(raw?.items).map(parseAlbum), undefined, 100);
  }

  /** Recently played tracks, newest first (one page: the API keeps only the last 50). */
  async recentlyPlayed(): Promise<SpotifyPlayed[]> {
    const raw = await this.request("GET", "/me/player/recently-played", { query: { limit: 50 } });
    return asArray(raw?.items)
      .map((entry: any) => {
        const item = parseItem(entry?.track);
        return item ? { item, contextUri: str(entry?.context?.uri) } : null;
      })
      .filter(isPresent);
  }

  async search(query: string, types: SpotifySearchType[], limit = 5): Promise<SpotifySearchResults> {
    const raw = await this.request("GET", "/search", {
      query: { q: query, type: types.join(","), limit: Math.max(1, Math.min(10, Math.round(limit))) },
    });
    return {
      tracks: asArray(raw?.tracks?.items).map(parseItem).filter(isPresent),
      albums: asArray(raw?.albums?.items).map(parseAlbum).filter(isPresent),
      artists: asArray(raw?.artists?.items).map(parseArtist).filter(isPresent),
      // Search results include nulls for playlists the API can no longer return.
      playlists: asArray(raw?.playlists?.items).map(parsePlaylist).filter(isPresent),
    };
  }

  /** Gather a paged listing by following its `next` links, up to maxItems. */
  private async collect<T>(
    path: string,
    query: Query,
    parse: (raw: any) => Array<T | null>,
    nextOf: (raw: any) => string = (raw) => str(raw?.next),
    maxItems = MAX_LIST_ITEMS,
  ): Promise<T[]> {
    const items: T[] = [];
    let raw = await this.request("GET", path, { query });
    for (;;) {
      for (const item of parse(raw)) if (item) items.push(item);
      const next = nextOf(raw);
      if (!next || items.length >= maxItems) return items.slice(0, maxItems);
      raw = await this.request("GET", next);
    }
  }

  /**
   * One API call. `path` is relative to the API base, or an absolute `next`
   * link from a page. Resolves to the parsed JSON body (null when empty);
   * a 401 refreshes the token and retries once.
   */
  private async request(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<any> {
    const url = path.startsWith("https://") ? path : `${SPOTIFY_API_BASE}${path}${buildQuery(options.query)}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    // A command without a body still sends an empty one: Spotify answers a
    // PUT or POST with no Content-Length with 411.
    const body = options.body !== undefined ? JSON.stringify(options.body) : method === "GET" ? undefined : "";
    for (let attempt = 0; ; attempt++) {
      const authorization = `Bearer ${await this.tokens.accessToken(attempt > 0)}`;
      const response = await withTimeout(this.fetchImpl(url, { method, headers: { ...headers, Authorization: authorization }, body }));
      const text = await withTimeout(response.text());
      if (response.status === 401 && attempt === 0) continue;
      if (response.status >= 200 && response.status < 300) {
        if (!text.trim()) return null;
        try {
          return JSON.parse(text);
        } catch {
          // Commands answer 200 with a snapshot id or plain text; nothing to read.
          return null;
        }
      }
      throw apiError(response.status, text);
    }
  }
}

/** Form / query encoding (not URLSearchParams, which the NativeScript runtime mishandles). */
export function buildQuery(query: Query | undefined): string {
  if (!query) return "";
  const parts = Object.keys(query)
    .filter((key) => query[key] !== undefined && query[key] !== "")
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(query[key]))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SpotifyApiError("Spotify didn't answer. Check the phone's connection.", 0)), HTTP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch (error) {
    if (error instanceof SpotifyApiError) throw error;
    throw new SpotifyApiError(`Can't reach Spotify: ${(error as Error)?.message ?? error}`, 0);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A message for the glasses from Spotify's error body ({error: {status, message, reason}}). */
function apiError(status: number, body: string): SpotifyApiError {
  let message = "";
  let reason = "";
  try {
    const parsed = JSON.parse(body);
    message = str(parsed?.error?.message ?? parsed?.error_description);
    reason = str(parsed?.error?.reason);
  } catch {
    // Not JSON (a gateway error page).
  }
  switch (reason) {
    case "NO_ACTIVE_DEVICE":
      return new SpotifyApiError("Spotify isn't open on any device. Open Spotify on your phone, then try again.", status, reason);
    case "PREMIUM_REQUIRED":
      return new SpotifyApiError("Controlling Spotify playback needs Spotify Premium.", status, reason);
  }
  if (status === 401) return new SpotifyApiError("Spotify no longer accepts this sign-in. Sign in again from the Music app menu.", status, reason);
  if (status === 403 && /registered|developer dashboard/i.test(message)) {
    return new SpotifyApiError("This Spotify account isn't on the client ID's user list (Developer Dashboard > User Management).", status, reason);
  }
  if (status === 429) return new SpotifyApiError("Spotify is limiting requests; try again in a minute.", status, reason);
  return new SpotifyApiError(message ? `Spotify: ${message}` : `Spotify error (HTTP ${status}).`, status, reason);
}

export function parsePlayback(raw: any): SpotifyPlayback {
  const repeat = str(raw?.repeat_state);
  const disallows = raw?.actions?.disallows;
  return {
    device: parseDevice(raw?.device),
    playing: raw?.is_playing === true,
    progressMs: num(raw?.progress_ms, 0),
    shuffle: raw?.shuffle_state === true,
    repeat: repeat === "context" || repeat === "track" ? repeat : "off",
    contextUri: str(raw?.context?.uri),
    item: parseItem(raw?.item),
    playingType: str(raw?.currently_playing_type) || "unknown",
    disallows: disallows && typeof disallows === "object" ? Object.keys(disallows).filter((key) => disallows[key] === true) : [],
  };
}

export function parseItem(raw: any): SpotifyItem | null {
  if (!raw || typeof raw !== "object" || typeof raw.uri !== "string" || !raw.uri) return null;
  if (raw.type === "episode") {
    const show = str(raw.show?.name);
    return {
      uri: raw.uri,
      type: "episode",
      name: str(raw.name),
      artists: show || str(raw.show?.publisher),
      album: show,
      durationMs: num(raw.duration_ms, -1),
      images: parseImages(raw.images?.length ? raw.images : raw.show?.images),
    };
  }
  return {
    uri: raw.uri,
    type: "track",
    name: str(raw.name),
    artists: joinNames(raw.artists),
    album: str(raw.album?.name),
    durationMs: num(raw.duration_ms, -1),
    images: parseImages(raw.album?.images),
  };
}

export function parseDevice(raw: any): SpotifyDevice | null {
  if (!raw || typeof raw !== "object") return null;
  const volume = raw.volume_percent;
  return {
    id: str(raw.id),
    name: str(raw.name),
    type: str(raw.type),
    active: raw.is_active === true,
    restricted: raw.is_restricted === true,
    volumePercent: typeof volume === "number" && Number.isFinite(volume) ? volume : -1,
    supportsVolume: raw.supports_volume === true,
  };
}

function parsePlaylist(raw: any): SpotifyPlaylist | null {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  return {
    id: str(raw.id),
    uri: str(raw.uri) || `spotify:playlist:${raw.id}`,
    name: str(raw.name),
    ownerId: str(raw.owner?.id),
    ownerName: str(raw.owner?.display_name) || str(raw.owner?.id),
    collaborative: raw.collaborative === true,
    // `items` replaced the deprecated `tracks` summary in 2026.
    total: num(raw.items?.total ?? raw.tracks?.total, -1),
  };
}

function parseAlbum(raw: any): SpotifyAlbum | null {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  return { id: str(raw.id), uri: str(raw.uri) || `spotify:album:${raw.id}`, name: str(raw.name), artists: joinNames(raw.artists) };
}

function parseArtist(raw: any): SpotifyArtist | null {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  return { id: str(raw.id), uri: str(raw.uri) || `spotify:artist:${raw.id}`, name: str(raw.name) };
}

function parseImages(raw: any): SpotifyImage[] {
  return asArray(raw)
    .filter((image: any) => image && typeof image.url === "string" && image.url)
    .map((image: any) => ({ url: image.url, width: num(image.width, 0), height: num(image.height, 0) }));
}

function joinNames(raw: any): string {
  return asArray(raw).map((entry: any) => str(entry?.name)).filter(Boolean).join(", ");
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
