import { Dialogs, Utils } from "@nativescript/core";
import type { GrayImage } from "../graphics/image";
import { grayImageFromPacket, PHOTO_TONE } from "./image-files";
import { fromData } from "./kotlin-data";
import {
  APPLE_MUSIC_APP_NAME,
  APPLE_MUSIC_PACKAGE,
  DEFAULT_MEDIA_STATE,
  type MediaControllerBridge,
  type MediaControllerState,
  type MediaPlaybackState,
  type MediaQueueItem,
} from "./media-types";
import { spotifyService } from "./spotify.ios";
import type { SpotifyPlayer } from "./spotify-player";

export type { MediaControllerState, MediaPlaybackState, MediaQueueItem } from "./media-types";

declare const FaceclawAppleMusic: any;
declare const FaceclawKitIosProtocol: any;

/**
 * Re-read the system player this often while something listens: its change
 * notifications are not delivered while Faceclaw is suspended, so a track
 * change in the background would otherwise wait for the next one.
 */
const POLL_MS = 2_000;

/** Normalize FaceclawAppleMusic.stateJson()'s object. */
export function appleMusicState(raw: any): MediaControllerState {
  if (!raw || raw.access !== true) {
    return { ...DEFAULT_MEDIA_STATE, status: "Apple Music access is required." };
  }
  const hasItem = Boolean(raw.hasItem);
  const playbackState: MediaPlaybackState = !hasItem
    ? "idle"
    : raw.state === "playing" || raw.state === "paused" || raw.state === "stopped" ? raw.state : "unknown";
  const rate = Number(raw.rate);
  return {
    available: hasItem,
    accessEnabled: true,
    packageName: APPLE_MUSIC_PACKAGE,
    appName: APPLE_MUSIC_APP_NAME,
    playbackState,
    title: String(raw.title ?? ""),
    artist: String(raw.artist ?? ""),
    album: String(raw.album ?? ""),
    positionMs: finiteOr(raw.positionMs, -1),
    durationMs: finiteOr(raw.durationMs, -1),
    // The system player reports a zero rate while it is still starting up.
    playbackSpeed: playbackState === "playing" ? (rate > 0 ? rate : 1) : 0,
    status: hasItem ? "" : "Nothing is playing in Apple Music.",
    canPlayPause: hasItem,
    canSkipNext: hasItem,
    canSkipPrevious: hasItem,
    artVersion: finiteOr(raw.artVersion, 0),
  };
}

function finiteOr(value: unknown, fallback: number): number {
  const number = Number(value);
  return typeof value === "number" && Number.isFinite(number) ? number : fallback;
}

/** Everything a listener would redraw for; the position advances on its own. */
function stateSignature(state: MediaControllerState): string {
  return JSON.stringify({ ...state, positionMs: 0 });
}

/**
 * Apple Music through FaceclawAppleMusic (MediaPlayer's system player): iOS
 * gives other apps' players no shared session API, so the system Music app is
 * the only player Faceclaw can follow and control. Snapshots read the player
 * directly (cheap property reads), so they are current even when a change
 * notification was missed.
 */
export class AppleMusicControllerBridge implements MediaControllerBridge {
  readonly accessPrompt = "Faceclaw needs access to Apple Music to show and control what's playing. Tap, then allow access on your phone.";
  readonly accessLabel = "Apple Music access needed";
  readonly accessAction = "allow access";
  readonly skipRebuildsQueue = false;
  private readonly stateListeners = new Set<(state: MediaControllerState) => void>();
  private bound = false;
  private started = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSignature = "";
  private pendingAccess: Promise<boolean> | null = null;
  private protocol: any = null;

  onStateChange(listener: (state: MediaControllerState) => void): () => void {
    void this.start();
    this.stateListeners.add(listener);
    this.pollTimer ??= setInterval(() => this.publish(), POLL_MS);
    listener(this.snapshot());
    return () => {
      this.stateListeners.delete(listener);
      if (!this.stateListeners.size && this.pollTimer !== null) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  snapshot(): MediaControllerState {
    let raw: unknown = null;
    try {
      raw = JSON.parse(String(this.native().stateJson()));
    } catch (error) {
      console.warn(`[apple-music] state read failed: ${error}`);
    }
    return appleMusicState(raw);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.native().start();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.native().stop();
  }

  async playPause(): Promise<void> {
    this.native().playPause();
  }

  async skipNext(): Promise<void> {
    this.native().skipNext();
  }

  async skipPrevious(): Promise<void> {
    this.native().skipPrevious();
  }

  hasAccess(): boolean {
    return Boolean(this.native().hasPermission());
  }

  /** Concurrent requests (glasses tap, phone Permissions card) share one prompt. */
  requestAccess(): Promise<boolean> {
    if (this.hasAccess()) return Promise.resolve(true);
    this.pendingAccess ??= this.askForAccess().finally(() => {
      this.pendingAccess = null;
      this.publish();
    });
    return this.pendingAccess;
  }

  async skipToQueueItem(id: number): Promise<void> {
    this.native().skipToQueueIndex(Math.round(id));
  }

  getMediaVolumePercent(): number {
    const volume = Number(this.native().volumePercent());
    return Number.isFinite(volume) ? Math.max(-1, Math.min(100, Math.round(volume))) : -1;
  }

  setMediaVolumePercent(volumePercent: number): void {
    this.native().setVolumePercent(Math.max(0, Math.min(100, Math.round(volumePercent))));
  }

  getAlbumArt(maxSize: number): GrayImage | null {
    const packet = this.native().albumArt(Math.round(maxSize));
    if (!packet) return null;
    // The shared Kotlin tone curve and dither, as on Android.
    this.protocol ??= FaceclawKitIosProtocol.new();
    return grayImageFromPacket(fromData(this.protocol.grayPacketBgraGammaDither(packet, PHOTO_TONE.gamma, PHOTO_TONE.dither)));
  }

  getQueue(): MediaQueueItem[] {
    try {
      const raw = JSON.parse(String(this.native().queueJson()));
      if (!Array.isArray(raw)) return [];
      return raw.map((item: { id?: number; title?: string; active?: boolean }) => ({
        id: Number(item?.id ?? -1),
        title: String(item?.title ?? ""),
        active: Boolean(item?.active),
      }));
    } catch (error) {
      console.warn(`[apple-music] queue parse failed: ${error}`);
      return [];
    }
  }

  private native(): any {
    const music = FaceclawAppleMusic.shared();
    if (!this.bound) {
      this.bound = true;
      music.changeHandler = () => this.publish();
    }
    return music;
  }

  private publish(): void {
    if (!this.stateListeners.size) return;
    const state = this.snapshot();
    const signature = stateSignature(state);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    for (const listener of this.stateListeners) listener(state);
  }

  private async askForAccess(): Promise<boolean> {
    const music = this.native();
    const status = String(music.permissionStatus());
    if (status === "denied") {
      const open = await Dialogs.confirm({
        title: "Apple Music Access",
        message: "Allow Media & Apple Music access in Settings to show and control Apple Music on your glasses.",
        okButtonText: "Open Settings",
        cancelButtonText: "Cancel",
      });
      if (open) Utils.openUrl("app-settings:");
      return false;
    }
    if (status === "restricted") {
      await Dialogs.alert({
        title: "Apple Music Access Restricted",
        message: "Media library access is restricted on this iPhone. Check Screen Time or device management settings.",
        okButtonText: "OK",
      });
      return false;
    }
    return new Promise<boolean>((resolve) => {
      music.requestPermission((granted: boolean) => resolve(Boolean(granted)));
    });
  }
}

export type IosMediaSource = "apple-music" | "spotify";

/**
 * Which player to follow: the one playing; with both playing, the current
 * choice (no flapping); with neither, the one that played last, and before
 * either has played this run, Spotify when it reports a session (its player
 * reports only a recently active one, while the system Music player keeps
 * its last item for days).
 */
export function chooseMediaSource(
  current: IosMediaSource,
  appleMusic: MediaControllerState,
  spotify: MediaControllerState | null,
  appleMusicLastPlayingAtMs: number,
  spotifyLastPlayingAtMs: number,
): IosMediaSource {
  if (!spotify?.accessEnabled) return "apple-music";
  if (!appleMusic.accessEnabled) return "spotify";
  const applePlaying = appleMusic.playbackState === "playing";
  const spotifyPlaying = spotify.playbackState === "playing";
  if (applePlaying && spotifyPlaying) return current;
  if (applePlaying) return "apple-music";
  if (spotifyPlaying) return "spotify";
  if (appleMusicLastPlayingAtMs !== spotifyLastPlayingAtMs) {
    return spotifyLastPlayingAtMs > appleMusicLastPlayingAtMs ? "spotify" : "apple-music";
  }
  return spotify.available ? "spotify" : "apple-music";
}

/**
 * The iOS Music bridge: Apple Music (the system player), plus Spotify once
 * signed in (its Web API: playback on this phone or any Spotify Connect
 * device). The state and every command follow one of them, by
 * chooseMediaSource.
 */
export class IosMediaControllerBridge implements MediaControllerBridge {
  readonly accessPrompt =
    "Faceclaw needs access to Apple Music to show and control what's playing. Tap, then allow access on your phone. For Spotify, sign in from the app menu instead.";
  readonly accessLabel: string;
  readonly accessAction: string;
  private source: IosMediaSource = "apple-music";
  private appleMusicLastPlayingAtMs = 0;
  private readonly listeners = new Set<(state: MediaControllerState) => void>();
  private unsubscribeSources: Array<() => void> = [];
  /** The source and its artVersion the composite artVersion was bumped for. */
  private artKey = "";
  private artVersion = 0;

  constructor(
    private readonly appleMusic: AppleMusicControllerBridge,
    private readonly spotify: () => SpotifyPlayer | null,
    private readonly now: () => number = Date.now,
  ) {
    this.accessLabel = appleMusic.accessLabel;
    this.accessAction = appleMusic.accessAction;
  }

  get skipRebuildsQueue(): boolean {
    return this.active().skipRebuildsQueue;
  }

  onStateChange(listener: (state: MediaControllerState) => void): () => void {
    if (!this.listeners.size) {
      const update = () => this.emit();
      const spotify = this.spotify();
      this.unsubscribeSources = [this.appleMusic.onStateChange(update), ...(spotify ? [spotify.onStateChange(update)] : [])];
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
    const appleMusic = this.appleMusic.snapshot();
    const spotify = this.spotify()?.snapshot() ?? null;
    this.select(appleMusic, spotify);
    const state = this.source === "spotify" && spotify ? spotify : appleMusic;
    // Changes with the source as well as with that source's art.
    const artKey = `${this.source}:${state.artVersion}`;
    if (artKey !== this.artKey) {
      this.artKey = artKey;
      this.artVersion++;
    }
    return {
      ...state,
      status: state.available ? state.status : idleStatus(appleMusic, spotify, state),
      artVersion: this.artVersion,
      // A Spotify command can fail while Apple Music is the one shown (playing from the Spotify library).
      notice: spotify?.notice || state.notice || "",
    };
  }

  async start(): Promise<void> {
    await this.appleMusic.start();
  }

  async stop(): Promise<void> {
    await this.appleMusic.stop();
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

  /** Apple Music's media-library permission (what requestAccess asks for); Spotify signs in from the Music menu. */
  hasAccess(): boolean {
    return this.appleMusic.hasAccess();
  }

  requestAccess(): Promise<boolean> {
    return this.appleMusic.requestAccess();
  }

  skipToQueueItem(id: number): Promise<void> {
    return this.active().skipToQueueItem(id);
  }

  getMediaVolumePercent(): number {
    return this.active().getMediaVolumePercent();
  }

  setMediaVolumePercent(volumePercent: number): void {
    this.active().setMediaVolumePercent(volumePercent);
  }

  getAlbumArt(maxSize: number): GrayImage | null {
    return this.active().getAlbumArt(maxSize);
  }

  getQueue(): MediaQueueItem[] {
    return this.active().getQueue();
  }

  async sendCustomAction(action: string): Promise<void> {
    await this.active().sendCustomAction?.(action);
  }

  async refresh(): Promise<void> {
    await this.spotify()?.refresh();
  }

  private active(): MediaControllerBridge {
    const spotify = this.spotify();
    this.select(this.appleMusic.snapshot(), spotify?.snapshot() ?? null);
    return this.source === "spotify" && spotify ? spotify : this.appleMusic;
  }

  private select(appleMusic: MediaControllerState, spotify: MediaControllerState | null): void {
    if (appleMusic.playbackState === "playing") this.appleMusicLastPlayingAtMs = this.now();
    this.source = chooseMediaSource(this.source, appleMusic, spotify, this.appleMusicLastPlayingAtMs,
      this.spotify()?.lastPlayingAtMs ?? 0);
  }

  /**
   * Forward every source update: each source already drops repeats, and
   * Spotify also signals changes that are not in the state (its queue).
   */
  private emit(): void {
    if (!this.listeners.size) return;
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}

/** The no-session line: which players were checked. */
function idleStatus(appleMusic: MediaControllerState, spotify: MediaControllerState | null, shown: MediaControllerState): string {
  if (appleMusic.accessEnabled && spotify?.accessEnabled) return "Nothing is playing.";
  return shown.status;
}

export const appleMusicControllerBridge = new AppleMusicControllerBridge();

export const mediaControllerBridge: MediaControllerBridge = new IosMediaControllerBridge(
  appleMusicControllerBridge,
  () => spotifyService()?.player ?? null,
);
