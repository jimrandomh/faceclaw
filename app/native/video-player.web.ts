/** Video files need the phone's hardware decoder path; the demo's Files app doesn't offer them. */
import type { GrayImage } from "../graphics/image";

export type VideoInfo = { width: number; height: number; durationMs: number; hasAudio: boolean };
export type VideoPlaybackState = "playing" | "paused" | "ended";
export type VideoPlayerCallbacks = { onState: (state: VideoPlaybackState, positionMs: number) => void; onError: (message: string) => void };
export type VideoStartOptions = { path: string; surfaceId: string; rect: { x: number; y: number; width: number; height: number }; monochrome: boolean; gamma: number; audio: boolean; startMs: number };

export function isPlayableVideoFile(_name: string): boolean { return false; }
export function probeVideo(_path: string): VideoInfo | { error: string } { return { error: "Video playback isn't available in the browser demo." }; }

export class VideoPlayer {
  constructor(private readonly callbacks: VideoPlayerCallbacks) {}
  start(_options: VideoStartOptions): void { this.callbacks.onError("Video playback isn't available in the browser demo."); }
  pause(): void {}
  resume(): void {}
  seekTo(_positionMs: number): void {}
  positionMs(): number { return 0; }
  isPlaying(): boolean { return false; }
  lastFrame(_width: number, _height: number): GrayImage | null { return null; }
  stop(): void {}
  release(): void {}
}
