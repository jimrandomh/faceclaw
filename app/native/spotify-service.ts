import type { GrayImage } from "../graphics/image";
import { onSettingsStoreChanged } from "./settings-store";
import {
  readSpotifyAccount,
  saveSpotifyAccount,
  signInToSpotify,
  SPOTIFY_ACCOUNT_KEY,
  SPOTIFY_CLIENT_ID_KEY,
  SpotifySession,
  type SpotifyAccount,
  type WebSignIn,
} from "./spotify-auth";
import { SpotifyLibrary } from "./spotify-library";
import { errorMessage, SpotifyPlayer } from "./spotify-player";
import { SpotifyClient, type SpotifyFetch, type SpotifySearchType } from "./spotify-web-api";

/** Give up on a sign-in nobody finished on the phone. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** What the platform supplies (spotify.ios.ts). */
export type SpotifyPlatform = {
  fetch: SpotifyFetch;
  webSignIn: WebSignIn;
  download(url: string): Promise<Uint8Array | null>;
  decodeArt(bytes: Uint8Array, maxSize: number): GrayImage | null;
  systemVolume: { get(): number; set(percent: number): void };
};

export type SpotifySignInState =
  | { phase: "idle"; error: string }
  /** The sign-in sheet is open on the phone, or waiting for Faceclaw to come to the foreground. */
  | { phase: "waiting"; error: "" };

/**
 * Spotify for the Music app, the media bridges and the assistant: the
 * account and its sign-in, the Web API client, the player and the library.
 */
export class SpotifyService {
  readonly client: SpotifyClient;
  readonly player: SpotifyPlayer;
  readonly library: SpotifyLibrary;
  private signInState: SpotifySignInState = { phase: "idle", error: "" };
  private readonly listeners = new Set<() => void>();
  private accountKey: string;

  constructor(private readonly platform: SpotifyPlatform) {
    const isSignedIn = () => readSpotifyAccount() !== null;
    this.client = new SpotifyClient(platform.fetch, new SpotifySession(platform.fetch));
    this.player = new SpotifyPlayer({
      client: this.client,
      isSignedIn,
      download: (url) => platform.download(url),
      decodeArt: (bytes, maxSize) => platform.decodeArt(bytes, maxSize),
      systemVolume: platform.systemVolume,
    });
    this.library = new SpotifyLibrary({
      client: this.client,
      player: this.player,
      isSignedIn,
      userId: () => readSpotifyAccount()?.userId ?? "",
    });
    this.accountKey = accountIdentity(readSpotifyAccount());
    onSettingsStoreChanged((key) => {
      if (key !== SPOTIFY_ACCOUNT_KEY && key !== SPOTIFY_CLIENT_ID_KEY) return;
      // Token refreshes rewrite the account too; only a different sign-in resets the player.
      const identity = accountIdentity(readSpotifyAccount());
      if (identity !== this.accountKey) {
        this.accountKey = identity;
        this.player.accountChanged();
      }
      this.emit();
    });
  }

  account(): SpotifyAccount | null {
    return readSpotifyAccount();
  }

  signInStatus(): SpotifySignInState {
    return this.signInState;
  }

  /** Repaint hook for the sign-in menu: account or sign-in progress changed. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Open Spotify's sign-in page on the phone (it waits for Faceclaw to be in
   * the foreground); the outcome lands in signInStatus().
   */
  async signIn(): Promise<void> {
    if (this.signInState.phase === "waiting") return;
    this.signInState = { phase: "waiting", error: "" };
    this.emit();
    const timer = setTimeout(() => this.platform.webSignIn.cancel(), SIGN_IN_TIMEOUT_MS);
    try {
      await signInToSpotify(this.platform.fetch, this.platform.webSignIn);
      this.signInState = { phase: "idle", error: "" };
    } catch (error) {
      const message = errorMessage(error);
      this.signInState = { phase: "idle", error: message === "cancelled" ? "" : message };
    } finally {
      clearTimeout(timer);
      this.emit();
    }
  }

  cancelSignIn(): void {
    this.platform.webSignIn.cancel();
  }

  signOut(): void {
    saveSpotifyAccount(null);
    this.signInState = { phase: "idle", error: "" };
    this.emit();
  }

  /**
   * Search Spotify and play the best match: a track, or the album, artist or
   * playlist when the request names that kind. Resolves to what started, or
   * rejects with why not.
   */
  async playSearch(query: string, kind: SpotifySearchType = "track"): Promise<string> {
    if (!readSpotifyAccount()) throw new Error("Not signed in to Spotify. Sign in under Spotify in the Music app menu on the glasses.");
    const results = await this.client.search(query, [kind], 3);
    let request: { contextUri?: string; uris?: string[] } | null = null;
    let description = "";
    if (kind === "track" && results.tracks[0]) {
      const track = results.tracks[0];
      request = { uris: [track.uri] };
      description = `${track.name}${track.artists ? ` by ${track.artists}` : ""}`;
    } else if (kind === "album" && results.albums[0]) {
      const album = results.albums[0];
      request = { contextUri: album.uri };
      description = `the album ${album.name}${album.artists ? ` by ${album.artists}` : ""}`;
    } else if (kind === "artist" && results.artists[0]) {
      request = { contextUri: results.artists[0].uri };
      description = results.artists[0].name;
    } else if (kind === "playlist" && results.playlists[0]) {
      request = { contextUri: results.playlists[0].uri };
      description = `the playlist ${results.playlists[0].name}`;
    }
    if (!request) throw new Error(`Spotify found no ${kind} matching "${query}".`);
    if (!(await this.player.startPlayback(request))) {
      throw new Error(this.player.snapshot().notice || "Spotify didn't start playback.");
    }
    return description;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function accountIdentity(account: SpotifyAccount | null): string {
  return account ? `${account.clientId}/${account.userId}` : "";
}
