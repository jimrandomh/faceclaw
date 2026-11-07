/** A pretend music player for the browser demo: real controls and progress over made-up tracks, with no audio. */
import type { GrayImage } from "../graphics/image";
import { DEMO_TRACKS, demoCoverArt } from "../web/demo-data/music";
import { DEFAULT_MEDIA_STATE, type MediaControllerBridge, type MediaControllerState, type MediaQueueItem } from "./media-types";

export type { MediaControllerState, MediaPlaybackState, MediaQueueItem } from "./media-types";

export const DEMO_PLAYER_PACKAGE = "org.faceclaw.demo.player";
export const DEMO_PLAYER_NAME = "Demo Player";

class DemoMediaController implements MediaControllerBridge {
  readonly accessPrompt = "";
  readonly accessLabel = "";
  readonly accessAction = "";
  readonly skipRebuildsQueue = false;
  private readonly listeners = new Set<(state: MediaControllerState) => void>();
  private index = 0;
  private playing = true;
  private anchorPositionMs = 42_000;
  private anchorAtMs = Date.now();
  private volume = 60;
  private artVersion = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.scheduleTrackEnd();
  }

  private positionMs(): number {
    return this.playing ? this.anchorPositionMs + (Date.now() - this.anchorAtMs) : this.anchorPositionMs;
  }

  private scheduleTrackEnd(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.playing) return;
    const remaining = DEMO_TRACKS[this.index]!.durationMs - this.positionMs();
    this.timer = setTimeout(() => this.jumpTo(this.index + 1), Math.max(0, remaining));
  }

  private jumpTo(index: number): void {
    this.index = (index + DEMO_TRACKS.length) % DEMO_TRACKS.length;
    this.anchorPositionMs = 0;
    this.anchorAtMs = Date.now();
    this.artVersion++;
    this.changed();
  }

  private changed(): void {
    this.scheduleTrackEnd();
    const state = this.snapshot();
    for (const listener of [...this.listeners]) listener(state);
  }

  onStateChange(listener: (state: MediaControllerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): MediaControllerState {
    const track = DEMO_TRACKS[this.index]!;
    return {
      ...DEFAULT_MEDIA_STATE,
      available: true,
      accessEnabled: true,
      packageName: DEMO_PLAYER_PACKAGE,
      appName: DEMO_PLAYER_NAME,
      playbackState: this.playing ? "playing" : "paused",
      title: track.title,
      artist: track.artist,
      album: track.album,
      positionMs: this.positionMs(),
      durationMs: track.durationMs,
      playbackSpeed: this.playing ? 1 : 0,
      status: "",
      canPlayPause: true,
      canSkipNext: true,
      canSkipPrevious: true,
      artVersion: this.artVersion,
    };
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async playPause(): Promise<void> {
    this.anchorPositionMs = this.positionMs();
    this.anchorAtMs = Date.now();
    this.playing = !this.playing;
    this.changed();
  }

  async skipNext(): Promise<void> { this.jumpTo(this.index + 1); }
  async skipPrevious(): Promise<void> { this.jumpTo(this.index - 1); }
  hasAccess(): boolean { return true; }
  async requestAccess(): Promise<boolean> { return true; }

  async skipToQueueItem(id: number): Promise<void> {
    const index = DEMO_TRACKS.findIndex((track) => track.id === id);
    if (index >= 0) { this.playing = true; this.jumpTo(index); }
  }

  /** The browse tree's "play this". */
  playTrack(id: number): void { void this.skipToQueueItem(id); }

  getMediaVolumePercent(): number { return this.volume; }

  setMediaVolumePercent(volumePercent: number): void {
    this.volume = Math.max(0, Math.min(100, Math.round(volumePercent)));
  }

  getAlbumArt(maxSize: number): GrayImage | null {
    return demoCoverArt(DEMO_TRACKS[this.index]!.coverSeed, maxSize);
  }

  getQueue(): MediaQueueItem[] {
    return DEMO_TRACKS.map((track, index) => ({ id: track.id, title: track.title, subtitle: track.artist, active: index === this.index }));
  }
}

export const mediaControllerBridge: DemoMediaController & MediaControllerBridge = new DemoMediaController();
