import type { MediaBrowseItem, MediaBrowserApp, MediaBrowserBridge } from "./media-types";
import { SPOTIFY_APP_NAME, SPOTIFY_PACKAGE, type SpotifyPlayer } from "./spotify-player";
import type { SpotifyClient, SpotifyItem, SpotifyPlayRequest } from "./spotify-web-api";

export const SPOTIFY_BROWSER_APP: MediaBrowserApp = { packageName: SPOTIFY_PACKAGE, serviceClass: "", appName: SPOTIFY_APP_NAME };

const ROOT_ROWS: MediaBrowseItem[] = [
  { mediaId: "recent", title: "Recently played", subtitle: "", browsable: true, playable: false },
  { mediaId: "playlists", title: "Playlists", subtitle: "", browsable: true, playable: false },
  { mediaId: "liked", title: "Liked Songs", subtitle: "", browsable: true, playable: true },
  { mediaId: "albums", title: "Albums", subtitle: "", browsable: true, playable: false },
  { mediaId: "artists", title: "Artists", subtitle: "", browsable: true, playable: false },
];

/** Separates a track's URI from the context it plays in ("" for none, "liked" for Liked Songs). */
const TRACK_CONTEXT_SEPARATOR = "|";

export type SpotifyLibraryDeps = {
  client: SpotifyClient;
  player: SpotifyPlayer;
  isSignedIn(): boolean;
  /** The signed-in user's id (Liked Songs' context URI names it). */
  userId(): string;
};

/**
 * The signed-in user's Spotify library as a browse tree (Web API):
 *
 *   root -> recent | playlists | liked | albums | artists
 *   playlist:<id>, album:<id>   -> tracks (browsable and playable)
 *   artist:<id>                 -> albums
 *   track:<uri>|<context>       -> plays the track within its context
 *
 * Only playlists the user owns or collaborates on can list their tracks
 * (development-mode client IDs, since February 2026); others are play-only.
 */
export class SpotifyLibrary implements MediaBrowserBridge {
  private connected = false;
  /** Bumped on every connect/disconnect; answers to older requests are dropped. */
  private generation = 0;

  constructor(private readonly deps: SpotifyLibraryDeps) {}

  listBrowsableApps(): MediaBrowserApp[] {
    return this.deps.isSignedIn() ? [SPOTIFY_BROWSER_APP] : [];
  }

  connect(app: MediaBrowserApp): Promise<string> {
    this.disconnect();
    if (app.packageName !== SPOTIFY_PACKAGE) return Promise.reject(new Error("Not a Spotify library"));
    if (!this.deps.isSignedIn()) return Promise.reject(new Error("Sign in under Spotify in the Music app menu first."));
    this.connected = true;
    return Promise.resolve("root");
  }

  async browse(parentId: string): Promise<MediaBrowseItem[]> {
    if (!this.connected) throw new Error("Not connected");
    const generation = this.generation;
    const rows = await this.list(parentId);
    if (generation !== this.generation) throw new Error("Disconnected");
    return rows;
  }

  playFromMediaId(mediaId: string): void {
    if (!this.connected) return;
    const request = this.playRequest(mediaId);
    if (request) void this.deps.player.startPlayback(request);
  }

  disconnect(): void {
    this.connected = false;
    this.generation++;
  }

  /** What playing a browse row starts; null for rows that don't play. */
  playRequest(mediaId: string): SpotifyPlayRequest | null {
    if (mediaId === "liked") return { contextUri: this.likedContextUri() };
    const [kind, ...rest] = mediaId.split(":");
    const id = rest.join(":");
    switch (kind) {
      case "playlist":
      case "album":
      case "artist":
        return id ? { contextUri: `spotify:${kind}:${id}` } : null;
      case "track": {
        const separator = id.lastIndexOf(TRACK_CONTEXT_SEPARATOR);
        const uri = separator < 0 ? id : id.slice(0, separator);
        const context = separator < 0 ? "" : id.slice(separator + 1);
        if (!uri) return null;
        if (context === "liked") return { contextUri: this.likedContextUri(), offsetUri: uri };
        return context ? { contextUri: context, offsetUri: uri } : { uris: [uri] };
      }
      default:
        return null;
    }
  }

  private async list(parentId: string): Promise<MediaBrowseItem[]> {
    const client = this.deps.client;
    if (parentId === "root") return ROOT_ROWS;
    if (parentId === "recent") {
      // The history repeats tracks; keep each one's latest play.
      const seen = new Set<string>();
      return (await client.recentlyPlayed())
        .filter((played) => !seen.has(played.item.uri) && seen.add(played.item.uri))
        .map((played) => trackRow(played.item, played.contextUri));
    }
    if (parentId === "playlists") {
      const userId = this.deps.userId();
      return (await client.playlists()).map((playlist) => {
        const listable = playlist.collaborative || playlist.ownerId === userId;
        return {
          mediaId: `playlist:${playlist.id}`,
          title: playlist.name,
          subtitle: listable ? "" : playlist.ownerName,
          browsable: listable,
          playable: true,
        };
      });
    }
    if (parentId === "liked") return (await client.savedTracks()).map((item) => trackRow(item, "liked"));
    if (parentId === "albums") return (await client.savedAlbums()).map(albumRow);
    if (parentId === "artists") {
      return (await client.followedArtists()).map((artist) => ({
        mediaId: `artist:${artist.id}`,
        title: artist.name,
        subtitle: "",
        browsable: true,
        playable: true,
      }));
    }
    const [kind, ...rest] = parentId.split(":");
    const id = rest.join(":");
    if (kind === "playlist") return (await client.playlistItems(id)).map((item) => trackRow(item, `spotify:playlist:${id}`));
    if (kind === "album") return (await client.albumTracks(id)).map((item) => trackRow(item, `spotify:album:${id}`));
    if (kind === "artist") return (await client.artistAlbums(id)).map(albumRow);
    throw new Error(`Unknown Spotify library item: ${parentId}`);
  }

  private likedContextUri(): string {
    return `spotify:user:${this.deps.userId()}:collection`;
  }
}

function trackRow(item: SpotifyItem, contextUri: string): MediaBrowseItem {
  return {
    mediaId: `track:${item.uri}${contextUri ? `${TRACK_CONTEXT_SEPARATOR}${contextUri}` : ""}`,
    title: item.name,
    subtitle: item.artists,
    browsable: false,
    playable: true,
  };
}

function albumRow(album: { id: string; name: string; artists: string }): MediaBrowseItem {
  return { mediaId: `album:${album.id}`, title: album.name, subtitle: album.artists, browsable: true, playable: true };
}
