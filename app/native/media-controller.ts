import { Utils } from "@nativescript/core";
import { GrayImage } from "../graphics/image";
import { grayImageFromPacket, PHOTO_TONE } from "./image-files";
import { ignoredMediaPackages, MEDIA_APPS_KEY, rememberMediaApps } from "./media-apps";
import { onSettingsStoreChanged } from "./settings-store";
import { isNotificationListenerEnabled } from "./notification-access";
import {
  DEFAULT_MEDIA_STATE,
  interpolateMediaState,
  type MediaControllerBridge,
  type MediaControllerState,
  type MediaPlaybackState,
  type MediaQueueItem,
} from "./media-types";
import { spotifyService } from "./spotify";
import { SPOTIFY_ANDROID_PACKAGE, type SpotifyPlayer } from "./spotify-player";

declare const com: any;

export type { MediaControllerState, MediaPlaybackState, MediaQueueItem } from "./media-types";

/** Android media sessions (any player that publishes one), through FaceclawMediaController. */
export class FaceclawMediaControllerBridge implements MediaControllerBridge {
  readonly accessPrompt = "Notification access is required to control Android media sessions. Tap to open settings.";
  readonly accessLabel = "Notification access needed";
  readonly accessAction = "open settings";
  readonly skipRebuildsQueue = true;
  private readonly stateListeners = new Set<(state: MediaControllerState) => void>();
  private controller: any = null;
  private listenerProxy: any = null;
  private state: MediaControllerState = { ...DEFAULT_MEDIA_STATE };
  private stateUpdatedAtMs = Date.now();
  private started = false;

  onStateChange(listener: (state: MediaControllerState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.snapshot());
    return () => this.stateListeners.delete(listener);
  }

  snapshot(): MediaControllerState {
    return interpolateMediaState(this.state, this.stateUpdatedAtMs, Date.now());
  }

  async start(): Promise<void> {
    if (this.started || !global.isAndroid) return;
    this.ensureController();
    this.started = true;
    this.controller?.start();
  }

  async stop(): Promise<void> {
    if (!this.started || !global.isAndroid) return;
    this.started = false;
    this.controller?.stop();
  }

  async playPause(): Promise<void> {
    this.ensureController();
    this.controller?.playPause();
  }

  async skipNext(): Promise<void> {
    this.ensureController();
    this.controller?.skipNext();
  }

  async skipPrevious(): Promise<void> {
    this.ensureController();
    this.controller?.skipPrevious();
  }

  hasAccess(): boolean {
    return isNotificationListenerEnabled();
  }

  /** Opens the notification-access settings screen; the grant is only visible once the app resumes. */
  async requestAccess(): Promise<boolean> {
    this.ensureController();
    this.controller?.openNotificationAccessSettings();
    return false;
  }

  /** Jump playback to a queue item (see getQueue). */
  async skipToQueueItem(id: number): Promise<void> {
    this.ensureController();
    this.controller?.skipToQueueItem(id);
  }

  /** Current Android music-stream volume normalized to 0..100. */
  getMediaVolumePercent(): number {
    if (!global.isAndroid) return -1;
    this.ensureController();
    if (!this.controller) return -1;
    return Math.max(-1, Math.min(100, Math.round(Number(this.controller.getMediaVolumePercent()))));
  }

  /** Set Android's music-stream volume from a normalized 0..100 value. */
  setMediaVolumePercent(volumePercent: number): void {
    if (!global.isAndroid) return;
    this.ensureController();
    this.controller?.setMediaVolumePercent(Math.max(0, Math.min(100, Math.round(volumePercent))));
  }

  /**
   * Album art for the current item, grayscale with the shared photo tone
   * (gamma-corrected and dithered onto the display's 16 levels), scaled to
   * fit maxSize; null when the player provides none.
   */
  getAlbumArt(maxSize: number): GrayImage | null {
    if (!global.isAndroid) return null;
    this.ensureController();
    if (!this.controller) return null;
    return grayImageFromPacket(
      this.controller.getAlbumArtGray(Math.round(maxSize), PHOTO_TONE.gamma, PHOTO_TONE.dither),
    );
  }

  /** The player's queue (playlist), empty when the player exposes none. */
  getQueue(): MediaQueueItem[] {
    if (!global.isAndroid) return [];
    this.ensureController();
    if (!this.controller) return [];
    const json = String(this.controller.getQueueJson() ?? "");
    if (!json) return [];
    try {
      const raw = JSON.parse(json) as Array<{ id?: number; title?: string; active?: boolean }>;
      return raw.map((item) => ({
        id: Number(item.id ?? -1),
        title: String(item.title ?? ""),
        active: Boolean(item.active),
      }));
    } catch (error) {
      console.warn(`media queue parse failed: ${error}`);
      return [];
    }
  }

  private ensureController(): void {
    if (!global.isAndroid || this.controller) return;
    const context = Utils.android.getApplicationContext();
    if (!context) {
      throw new Error("Android application context unavailable");
    }
    this.controller = new com.faceclaw.app.FaceclawMediaController(context);
    // Install defaults and saved overrides before starting session discovery.
    this.controller.setIgnoredPackagesJson(JSON.stringify(ignoredMediaPackages()));
    onSettingsStoreChanged((key) => {
      if (key === MEDIA_APPS_KEY) {
        this.controller.setIgnoredPackagesJson(JSON.stringify(ignoredMediaPackages()));
      }
    });
    this.listenerProxy = new com.faceclaw.app.FaceclawMediaControllerListener({
      onSessionAppsChanged: (appsJson: string) => {
        try {
          const apps = JSON.parse(String(appsJson));
          rememberMediaApps(apps);
        } catch (error) {
          console.warn(`media session apps parse failed: ${error}`);
        }
      },
      onStateChange: (
        playbackState: string,
        packageName: string,
        appName: string,
        title: string,
        artist: string,
        album: string,
        positionMs: number,
        durationMs: number,
        playbackSpeed: number,
        canPlayPause: boolean,
        canSkipNext: boolean,
        canSkipPrevious: boolean,
        accessEnabled: boolean,
        status: string,
        artVersion: number,
      ) => {
        this.state = {
          available: Boolean(title || artist || album || packageName) || String(playbackState) !== "idle",
          accessEnabled: Boolean(accessEnabled),
          packageName: String(packageName),
          appName: String(appName),
          playbackState: normalizePlaybackState(String(playbackState)),
          title: String(title),
          artist: String(artist),
          album: String(album),
          positionMs: Number(positionMs),
          durationMs: Number(durationMs),
          playbackSpeed: Number(playbackSpeed),
          status: String(status),
          canPlayPause: Boolean(canPlayPause),
          canSkipNext: Boolean(canSkipNext),
          canSkipPrevious: Boolean(canSkipPrevious),
          artVersion: Number(artVersion),
        };
        this.stateUpdatedAtMs = Date.now();
        for (const listener of this.stateListeners) {
          listener(this.snapshot());
        }
      },
    });
    this.controller.setListener(this.listenerProxy);
  }
}

function normalizePlaybackState(value: string): MediaPlaybackState {
  switch (value) {
    case "notification-access-required":
    case "idle":
    case "playing":
    case "paused":
    case "buffering":
    case "stopped":
      return value;
    default:
      return "unknown";
  }
}

export type AndroidMediaSource = "session" | "spotify";

/**
 * Which to follow: the media session (any player, Spotify included when it
 * runs on this phone) or Spotify's Web API player (signed in; it also sees
 * Spotify playing on a computer or speaker). The one playing; with both
 * playing, the session when it is Spotify's own (the same playback), else the
 * current choice (no flapping); with neither, a Spotify session, then the one
 * that played last, then whichever has something. Without notification
 * access the session shows its access prompt unless Spotify has something.
 */
export function chooseAndroidMediaSource(
  current: AndroidMediaSource,
  session: MediaControllerState,
  spotify: MediaControllerState | null,
  sessionLastPlayingAtMs: number,
  spotifyLastPlayingAtMs: number,
): AndroidMediaSource {
  if (!spotify?.accessEnabled) return "session";
  if (!session.accessEnabled) return spotify.available ? "spotify" : "session";
  const sessionIsSpotify = session.packageName === SPOTIFY_ANDROID_PACKAGE;
  const sessionPlaying = session.playbackState === "playing";
  const spotifyPlaying = spotify.playbackState === "playing";
  if (sessionPlaying && spotifyPlaying) return sessionIsSpotify ? "session" : current;
  if (sessionPlaying) return "session";
  if (spotifyPlaying) return "spotify";
  if (sessionIsSpotify && session.available) return "session";
  if (sessionLastPlayingAtMs !== spotifyLastPlayingAtMs) {
    return spotifyLastPlayingAtMs > sessionLastPlayingAtMs ? "spotify" : "session";
  }
  return session.available || !spotify.available ? "session" : "spotify";
}

/**
 * The Android Music bridge: media sessions, plus Spotify's Web API once
 * signed in (optional). Spotify playing on this phone stays the session's:
 * its state, art, queue and transport come from the session (instant, no
 * quota), and the Web API adds what the session lacks: shuffle / repeat /
 * like rows and the volume of a Spotify Connect speaker or computer. Spotify
 * playing on another device, with no session here, follows the Web API player.
 */
export class AndroidMediaControllerBridge implements MediaControllerBridge {
  readonly accessPrompt: string;
  readonly accessLabel: string;
  readonly accessAction: string;
  private source: AndroidMediaSource = "session";
  private sessionLastPlayingAtMs = 0;
  private readonly listeners = new Set<(state: MediaControllerState) => void>();
  private unsubscribeSources: Array<() => void> = [];
  /** The source and its artVersion the composite artVersion was bumped for. */
  private artKey = "";
  private artVersion = 0;
  /** The player the last getQueue listed, so a jump goes to the same one. */
  private queueSource: MediaControllerBridge | null = null;
  /** A Spotify session's item and play state, to re-read the Web API when they change. */
  private spotifySessionKey = "";

  constructor(
    private readonly session: MediaControllerBridge,
    private readonly spotify: () => SpotifyPlayer | null,
    private readonly now: () => number = Date.now,
  ) {
    this.accessPrompt = session.accessPrompt;
    this.accessLabel = session.accessLabel;
    this.accessAction = session.accessAction;
  }

  get skipRebuildsQueue(): boolean {
    return (this.queueSource ?? this.active()).skipRebuildsQueue;
  }

  onStateChange(listener: (state: MediaControllerState) => void): () => void {
    if (!this.listeners.size) {
      const spotify = this.spotify();
      this.unsubscribeSources = [
        this.session.onStateChange((state) => this.sessionChanged(state)),
        ...(spotify ? [spotify.onStateChange(() => this.emit())] : []),
      ];
    }
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      for (const unsubscribe of this.unsubscribeSources) unsubscribe();
      this.unsubscribeSources = [];
    };
  }

  snapshot(): MediaControllerState {
    const session = this.session.snapshot();
    const spotify = this.spotify()?.snapshot() ?? null;
    this.select(session, spotify);
    const state = this.source === "spotify" && spotify ? spotify : withSpotifyExtras(session, spotify);
    // Changes with the source as well as with that source's art.
    const artKey = `${this.source}:${state.artVersion}`;
    if (artKey !== this.artKey) {
      this.artKey = artKey;
      this.artVersion++;
    }
    return {
      ...state,
      artVersion: this.artVersion,
      // A Spotify command can fail while the session is the one shown (playing from the Spotify library).
      notice: spotify?.notice || state.notice || "",
    };
  }

  async start(): Promise<void> {
    await this.session.start();
  }

  async stop(): Promise<void> {
    await this.session.stop();
  }

  playPause(): Promise<void> {
    return this.active().playPause();
  }

  skipNext(): Promise<void> {
    return this.active().skipNext();
  }

  skipPrevious(): Promise<void> {
    return this.active().skipPrevious();
  }

  /** Notification access (what requestAccess opens); Spotify signs in from the Music menu. */
  hasAccess(): boolean {
    return this.session.hasAccess();
  }

  requestAccess(): Promise<boolean> {
    return this.session.requestAccess();
  }

  skipToQueueItem(id: number): Promise<void> {
    return (this.queueSource ?? this.active()).skipToQueueItem(id);
  }

  /** Spotify's own volume logic (a Connect device's volume, else this phone's) whenever Spotify is shown. */
  getMediaVolumePercent(): number {
    return this.volumeSource().getMediaVolumePercent();
  }

  setMediaVolumePercent(volumePercent: number): void {
    this.volumeSource().setMediaVolumePercent(volumePercent);
  }

  getAlbumArt(maxSize: number): GrayImage | null {
    return this.active().getAlbumArt(maxSize);
  }

  /** The session's queue; for a Spotify session that lists none, the Web API's. */
  getQueue(): MediaQueueItem[] {
    const active = this.active();
    const queue = active.getQueue();
    const spotify = this.spotifyExtras();
    if (queue.length || active !== this.session || !spotify) {
      this.queueSource = active;
      return queue;
    }
    this.queueSource = spotify;
    return spotify.getQueue();
  }

  /** Spotify's actions (shown with a Spotify session too) go to the Web API player; any others to the session. */
  async sendCustomAction(action: string): Promise<void> {
    const spotify = this.spotify();
    if (spotify && spotify.snapshot().customActions?.some((custom) => custom.action === action)) {
      await spotify.sendCustomAction(action);
    } else {
      await this.session.sendCustomAction?.(action);
    }
  }

  async refresh(): Promise<void> {
    await this.spotify()?.refresh();
  }

  private active(): MediaControllerBridge {
    const spotify = this.spotify();
    this.select(this.session.snapshot(), spotify?.snapshot() ?? null);
    return this.source === "spotify" && spotify ? spotify : this.session;
  }

  /** The signed-in Web API player when it describes what the session shows (Spotify's own session); else null. */
  private spotifyExtras(): SpotifyPlayer | null {
    const spotify = this.spotify();
    if (!spotify || this.session.snapshot().packageName !== SPOTIFY_ANDROID_PACKAGE) return null;
    return spotify.snapshot().available ? spotify : null;
  }

  private volumeSource(): MediaControllerBridge {
    const active = this.active();
    return active === this.session ? this.spotifyExtras() ?? this.session : active;
  }

  private select(session: MediaControllerState, spotify: MediaControllerState | null): void {
    if (session.playbackState === "playing") this.sessionLastPlayingAtMs = this.now();
    this.source = chooseAndroidMediaSource(this.source, session, spotify, this.sessionLastPlayingAtMs,
      this.spotify()?.lastPlayingAtMs ?? 0);
  }

  private sessionChanged(state: MediaControllerState): void {
    // Spotify's session changed track or started / stopped: re-read the Web
    // API now, so its rows (like this song, shuffle) follow at once rather
    // than at the next poll. Signed out, the player skips the request.
    const key = state.packageName === SPOTIFY_ANDROID_PACKAGE ? `${state.title}\n${state.playbackState}` : "";
    if (key !== this.spotifySessionKey) {
      this.spotifySessionKey = key;
      if (key) void this.spotify()?.refresh();
    }
    this.emit();
  }

  /** Forward every source update: each drops its own repeats, and Spotify also signals queue changes. */
  private emit(): void {
    if (!this.listeners.size) return;
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}

/**
 * Spotify's session state plus what only the Web API knows: its custom rows
 * and, when it plays elsewhere, the device ("Spotify · Kitchen"). "Like
 * song" names the Web API's current item, so it is left out until both agree
 * on the track (the API lags a skip by up to a poll).
 */
export function withSpotifyExtras(session: MediaControllerState, spotify: MediaControllerState | null): MediaControllerState {
  if (!spotify?.available || session.packageName !== SPOTIFY_ANDROID_PACKAGE) return session;
  const sameItem = spotify.title === session.title;
  const actions = (spotify.customActions ?? []).filter((custom) => sameItem || custom.action !== "like");
  return {
    ...session,
    appName: sameItem ? spotify.appName : session.appName,
    customActions: [...(session.customActions ?? []), ...actions],
  };
}

const sessionBridge = new FaceclawMediaControllerBridge();

export const mediaControllerBridge: MediaControllerBridge = new AndroidMediaControllerBridge(
  sessionBridge,
  () => spotifyService()?.player ?? null,
);
