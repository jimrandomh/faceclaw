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
    this.pollTimer ??= setInterval(() => this.refresh(), POLL_MS);
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
      this.refresh();
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
      music.changeHandler = () => this.refresh();
    }
    return music;
  }

  private refresh(): void {
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

export const mediaControllerBridge: MediaControllerBridge = new AppleMusicControllerBridge();
