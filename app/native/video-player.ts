/**
 * Bridge to the Android FaceclawVideoPlayer: decodes a video file and
 * streams its frames, scaled to gray, straight into a rect of a window's
 * compositor surface, with the audio on the phone's default media route.
 * Android only; on iOS probeVideo reports an error and nothing plays.
 */
import { Utils } from "@nativescript/core";
import { GrayImage } from "../graphics/image";

declare const com: any;
declare const java: any;
declare const global: any;

/** Containers MediaExtractor opens (AVI is not one of them). */
const PLAYABLE_VIDEO = /\.(mp4|m4v|mkv|webm|3gp|mov)$/i;

export function isPlayableVideoFile(name: string): boolean {
  return PLAYABLE_VIDEO.test(name);
}

export type VideoInfo = {
  /** Display size, rotation already applied. */
  width: number;
  height: number;
  durationMs: number;
  hasAudio: boolean;
};

/** Read a video's size, duration and tracks; an error string when it can't be played. */
export function probeVideo(path: string): VideoInfo | { error: string } {
  if (!global.isAndroid) return { error: "Video playback is not supported on this phone" };
  try {
    const raw = JSON.parse(String(com.faceclaw.app.FaceclawVideoPlayer.probe(path)));
    if (raw.error) return { error: String(raw.error) };
    return {
      width: Number(raw.width) || 0,
      height: Number(raw.height) || 0,
      durationMs: Number(raw.durationMs) || 0,
      hasAudio: Boolean(raw.hasAudio),
    };
  } catch (error) {
    return { error: String(error) };
  }
}

export type VideoPlaybackState = "playing" | "paused" | "ended";

export type VideoPlayerCallbacks = {
  /** State change, or a paused seek that landed on a new frame (state "paused"). */
  onState: (state: VideoPlaybackState, positionMs: number) => void;
  onError: (message: string) => void;
};

export type VideoStartOptions = {
  path: string;
  surfaceId: string;
  /** The video's rect in surface coordinates. */
  rect: { x: number; y: number; width: number; height: number };
  monochrome: boolean;
  /** Tone curve for gray output (ignored for monochrome); see PHOTO_GAMMA. */
  gamma: number;
  audio: boolean;
  startMs: number;
};

/** One player; frames go to whatever surface the latest start() named. Main thread only. */
export class VideoPlayer {
  private readonly player: any;
  // The Java listener proxy must stay referenced or it gets GC'd.
  private readonly listenerProxy: any;
  // Reused direct buffer (and its JS view) for copyLastFrame; see java-direct-buffer.ts
  // for why frames cross as a Java-allocated buffer.
  private frameBuffer: any = null;
  private frameView: Uint8Array | null = null;

  constructor(callbacks: VideoPlayerCallbacks) {
    this.player = new com.faceclaw.app.FaceclawVideoPlayer(Utils.android.getApplicationContext());
    this.listenerProxy = new com.faceclaw.app.FaceclawVideoPlayer.Listener({
      onStateChanged: (state: string, positionMs: number) => {
        callbacks.onState(String(state) as VideoPlaybackState, Number(positionMs));
      },
      onError: (message: string) => callbacks.onError(String(message ?? "Playback failed")),
    });
    this.player.setListener(this.listenerProxy);
  }

  start(options: VideoStartOptions): void {
    const { rect } = options;
    this.player.start(
      options.path,
      options.surfaceId,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
      options.monochrome,
      options.gamma,
      options.audio,
      Math.max(0, Math.round(options.startMs)),
    );
  }

  /** Once this returns, no more frames reach the surface until resume(). */
  pause(): void {
    this.player.pause();
  }

  resume(): void {
    this.player.resume();
  }

  seekTo(positionMs: number): void {
    this.player.seekTo(Math.max(0, Math.round(positionMs)));
  }

  positionMs(): number {
    return Number(this.player.getPositionMs());
  }

  isPlaying(): boolean {
    return Boolean(this.player.isPlaying());
  }

  /** The latest decoded frame at the given size, or null before one exists. */
  lastFrame(width: number, height: number): GrayImage | null {
    const bytes = width * height;
    if (bytes <= 0) return null;
    if (!this.frameView || this.frameView.length !== bytes) {
      this.frameBuffer = java.nio.ByteBuffer.allocateDirect(bytes);
      this.frameView = new Uint8Array((ArrayBuffer as any).from(this.frameBuffer));
    }
    if (!this.player.copyLastFrame(this.frameBuffer)) return null;
    const image = new GrayImage(width, height, 0);
    image.pixels.set(this.frameView);
    return image;
  }

  /** End playback and free the decoder and audio (the last frame stays readable). */
  stop(): void {
    this.player.stop();
  }

  release(): void {
    this.player.release();
    this.frameBuffer = null;
    this.frameView = null;
  }
}
