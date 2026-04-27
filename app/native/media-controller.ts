import { Utils } from "@nativescript/core";

declare const com: any;

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
  playbackState: MediaPlaybackState;
  title: string;
  artist: string;
  album: string;
  status: string;
  canPlayPause: boolean;
  canSkipNext: boolean;
  canSkipPrevious: boolean;
};

const DEFAULT_MEDIA_STATE: MediaControllerState = {
  available: false,
  accessEnabled: false,
  packageName: "",
  playbackState: "idle",
  title: "",
  artist: "",
  album: "",
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
  private started = false;

  onStateChange(listener: (state: MediaControllerState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.snapshot());
    return () => this.stateListeners.delete(listener);
  }

  snapshot(): MediaControllerState {
    return { ...this.state };
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
        title: string,
        artist: string,
        album: string,
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
          playbackState: normalizePlaybackState(String(playbackState)),
          title: String(title),
          artist: String(artist),
          album: String(album),
          status: String(status),
          canPlayPause: Boolean(canPlayPause),
          canSkipNext: Boolean(canSkipNext),
          canSkipPrevious: Boolean(canSkipPrevious),
        };
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
