import type { GrayImage } from "../graphics/image";

/**
 * Shapes shared by the media bridges: media-controller.ts / media-browser.ts
 * drive Android media sessions and MediaBrowserServices; their .ios.ts
 * counterparts drive Apple Music through the MediaPlayer framework.
 */

/** The player behind the iOS bridges: the system Music app. */
export const APPLE_MUSIC_APP_NAME = "Apple Music";
export const APPLE_MUSIC_PACKAGE = "com.apple.Music";

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
  /**
   * Changes whenever getAlbumArt's result may have changed (any metadata
   * update or session switch). Key cached art on this, not the title:
   * players re-publish the same strings with a different bitmap.
   */
  artVersion: number;
};

export const DEFAULT_MEDIA_STATE: MediaControllerState = {
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
  artVersion: 0,
};

/** Interpolate the position of a playing item from the last state update. */
export function interpolateMediaState(state: MediaControllerState, updatedAtMs: number, nowMs: number): MediaControllerState {
  const result = { ...state };
  if (result.playbackState === "playing" && result.positionMs >= 0 && result.playbackSpeed !== 0) {
    result.positionMs += (nowMs - updatedAtMs) * result.playbackSpeed;
    result.positionMs = Math.max(0, result.durationMs > 0 ? Math.min(result.positionMs, result.durationMs) : result.positionMs);
  }
  return result;
}

export interface MediaControllerBridge {
  /** Explains, on the glasses, what access is missing and that a tap asks for it. */
  readonly accessPrompt: string;
  /** The missing access as a short card label. */
  readonly accessLabel: string;
  /** What clicking the access prompt does, for its gesture hint. */
  readonly accessAction: string;
  /**
   * Whether jumping to a queue item rebuilds the queue with that item first
   * (Android players do); otherwise the queue keeps its order.
   */
  readonly skipRebuildsQueue: boolean;
  onStateChange(listener: (state: MediaControllerState) => void): () => void;
  snapshot(): MediaControllerState;
  start(): Promise<void>;
  stop(): Promise<void>;
  playPause(): Promise<void>;
  skipNext(): Promise<void>;
  skipPrevious(): Promise<void>;
  hasAccess(): boolean;
  /** Show the grant UI: a system settings screen or a permission prompt on the phone. */
  requestAccess(): Promise<boolean>;
  /** Jump playback to a queue item (see getQueue). */
  skipToQueueItem(id: number): Promise<void>;
  /** Media volume normalized to 0..100; -1 when unavailable. */
  getMediaVolumePercent(): number;
  setMediaVolumePercent(volumePercent: number): void;
  /**
   * Album art for the current item, grayscale with the shared photo tone
   * (gamma-corrected and dithered onto the display's 16 levels), scaled to
   * fit maxSize; null when the player provides none.
   */
  getAlbumArt(maxSize: number): GrayImage | null;
  /** The player's queue (playlist), empty when the player exposes none. */
  getQueue(): MediaQueueItem[];
}

export type MediaBrowserApp = {
  packageName: string;
  serviceClass: string;
  appName: string;
};

export type MediaBrowseItem = {
  mediaId: string;
  title: string;
  subtitle: string;
  browsable: boolean;
  playable: boolean;
};

export interface MediaBrowserBridge {
  /** Apps whose library can be browsed; cached after the first call. */
  listBrowsableApps(refresh?: boolean): MediaBrowserApp[];
  /** Connect to an app's library, replacing any existing connection. Resolves to the browse-tree root id. */
  connect(app: MediaBrowserApp): Promise<string>;
  /** Fetch one level of the connected library's tree. */
  browse(parentId: string): Promise<MediaBrowseItem[]>;
  /** Start playback of a browsed item. */
  playFromMediaId(mediaId: string): void;
  /** Drop the connection; in-flight requests are rejected. */
  disconnect(): void;
}

/** Parse a browse listing's JSON rows. */
export function parseMediaBrowseItems(json: string): MediaBrowseItem[] {
  const raw = JSON.parse(json) as Array<{
    mediaId?: string;
    title?: string;
    subtitle?: string;
    browsable?: boolean;
    playable?: boolean;
  }>;
  return raw.map((item) => ({
    mediaId: String(item.mediaId ?? ""),
    title: String(item.title ?? ""),
    subtitle: String(item.subtitle ?? ""),
    browsable: Boolean(item.browsable),
    playable: Boolean(item.playable),
  }));
}
