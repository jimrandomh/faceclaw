import { Utils } from "@nativescript/core";
import { GrayImage } from "../graphics/image";
import { grayImageFromPacket, PHOTO_TONE } from "./image-files";

declare const com: any;

export type MediaQueueItem = {
  id: number;
  title: string;
  active: boolean;
};

export type MediaPlaybackState =
  | "notification-access-required"
  | "idle"
  | "playing"
  | "paused"
  | "buffering"
  | "stopped"
  | "unknown";

export type MediaControllerState = {
  available: boolean;
  accessEnabled: boolean;
  packageName: string;
  appName: string;
  playbackState: MediaPlaybackState;
  title: string;
  artist: string;
  album: string;
  positionMs: number;
  durationMs: number;
  playbackSpeed: number;
  status: string;
  canPlayPause: boolean;
  canSkipNext: boolean;
  canSkipPrevious: boolean;
};

const DEFAULT_MEDIA_STATE: MediaControllerState = {
  available: false,
  accessEnabled: false,
  packageName: "",
  appName: "",
  playbackState: "idle",
  title: "",
  artist: "",
  album: "",
  positionMs: -1,
  durationMs: -1,
  playbackSpeed: 0,
  status: "Media controller unavailable.",
  canPlayPause: false,
  canSkipNext: false,
  canSkipPrevious: false,
};

export class FaceclawMediaControllerBridge {
  private readonly stateListeners = new Set<(state: MediaControllerState) => void>();
  private controller: any | null = null;
  private listenerProxy: any | null = null;
  private state: MediaControllerState = { ...DEFAULT_MEDIA_STATE };
  private stateUpdatedAtMs = Date.now();
  private started = false;

  onStateChange(listener: (state: MediaControllerState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.snapshot());
    return () => this.stateListeners.delete(listener);
  }

  snapshot(): MediaControllerState {
    const state = { ...this.state };
    if (state.playbackState === "playing" && state.positionMs >= 0 && state.playbackSpeed !== 0) {
      state.positionMs += (Date.now() - this.stateUpdatedAtMs) * state.playbackSpeed;
      state.positionMs = Math.max(0, state.durationMs > 0 ? Math.min(state.positionMs, state.durationMs) : state.positionMs);
    }
    return state;
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

  openNotificationAccessSettings(): void {
    this.ensureController();
    this.controller?.openNotificationAccessSettings();
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
    this.listenerProxy = new com.faceclaw.app.FaceclawMediaControllerListener({
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

export const mediaControllerBridge = new FaceclawMediaControllerBridge();
