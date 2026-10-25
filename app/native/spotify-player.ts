import type { GrayImage } from "../graphics/image";
import {
  DEFAULT_MEDIA_STATE,
  interpolateMediaState,
  type MediaControllerBridge,
  type MediaControllerState,
  type MediaCustomAction,
  type MediaQueueItem,
} from "./media-types";
import {
  SpotifyApiError,
  type SpotifyClient,
  type SpotifyDevice,
  type SpotifyItem,
  type SpotifyPlayback,
  type SpotifyPlayRequest,
  type SpotifyRepeat,
} from "./spotify-web-api";

export const SPOTIFY_APP_NAME = "Spotify";
/** The iOS app's bundle id; Spotify's Android package is com.spotify.music. */
export const SPOTIFY_PACKAGE = "com.spotify.client";

/**
 * Poll intervals while something listens. The Web API has no push channel, so
 * a track change shows up within one interval (sooner at a track's end, which
 * is polled for directly); requests count against the client ID's quota.
 */
const POLL_PLAYING_MS = 5_000;
const POLL_PAUSED_MS = 10_000;
const POLL_IDLE_MS = 20_000;
const POLL_ERROR_MS = 30_000;
/** Re-read soon after a command: Spotify takes a moment to report its effect. */
const SETTLE_POLL_MS = 600;
const SETTLE_POLLS = 2;
const NOTICE_MS = 8_000;
/** Re-read the queue this often while the Music app shows it, besides on every track change. */
const QUEUE_MAX_AGE_MS = 30_000;
/** At most this often, even on track changes (and after a failed read). */
const QUEUE_MIN_INTERVAL_MS = 5_000;
/** Album art: the smallest of Spotify's sizes (640/300/64) at least this wide. */
const ART_MIN_WIDTH = 128;

const REPEAT_NEXT: Record<SpotifyRepeat, SpotifyRepeat> = { off: "context", context: "track", track: "off" };
const REPEAT_LABEL: Record<SpotifyRepeat, string> = { off: "Repeat: off", context: "Repeat: all", track: "Repeat: one" };

export type SpotifyPlayerDeps = {
  client: SpotifyClient;
  isSignedIn(): boolean;
  /** Fetch an album-art image's encoded bytes; null on failure. */
  download(url: string): Promise<Uint8Array | null>;
  /** Encoded image bytes to the shared photo tone, fitted within maxSize; null when undecodable. */
  decodeArt(bytes: Uint8Array, maxSize: number): GrayImage | null;
  /** The phone's output volume, for playback on this phone (Spotify won't set a phone's volume). */
  systemVolume: { get(): number; set(percent: number): void };
  now?: () => number;
};

/**
 * Spotify Connect playback (on this phone or any of the user's devices)
 * through the Web API: state from polling GET /me/player while something
 * listens, commands as API calls whose failures (no device, no Premium)
 * become a short notice in the state.
 */
export class SpotifyPlayer implements MediaControllerBridge {
  readonly accessPrompt = "Sign in to Spotify from the Music app menu to show and control Spotify.";
  readonly accessLabel = "Spotify sign-in needed";
  readonly accessAction = "open the menu";
  /** Jumping skips forward through the queue, so the chosen track ends up first. */
  readonly skipRebuildsQueue = true;
  /** When Spotify was last seen playing (epoch ms); 0 = not this run. */
  lastPlayingAtMs = 0;

  private readonly now: () => number;
  private readonly listeners = new Set<(state: MediaControllerState) => void>();
  private playback: SpotifyPlayback | null = null;
  private fetchedAtMs = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling: Promise<void> | null = null;
  private pollAgain = false;
  private settlePolls = 0;
  private lastSignature = "";
  private notice = "";
  private noticeUntilMs = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private upcoming: SpotifyItem[] = [];
  /** The item the queue was read with; "" = never read. */
  private queueCurrentUri = "";
  /** When the queue was last read, or a read failed. */
  private queueFetchedAtMs = 0;
  private queueLoading = false;
  private art: { url: string; bytes: Uint8Array | null; decoded: Map<number, GrayImage | null> } | null = null;
  private artVersion = 0;
  private liked: { uri: string; value: boolean | null } | null = null;
  private volumeTarget: number | null = null;
  private volumeSending = false;

  constructor(private readonly deps: SpotifyPlayerDeps) {
    this.now = deps.now ?? Date.now;
  }

  onStateChange(listener: (state: MediaControllerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    if (this.listeners.size === 1) this.schedulePoll(0);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && !this.settlePolls) this.clearPollTimer();
    };
  }

  snapshot(): MediaControllerState {
    const notice = this.currentNotice();
    if (!this.deps.isSignedIn()) {
      return { ...DEFAULT_MEDIA_STATE, status: "Not signed in to Spotify.", notice };
    }
    const playback = this.playback;
    if (!playback) {
      return {
        ...DEFAULT_MEDIA_STATE,
        accessEnabled: true,
        packageName: SPOTIFY_PACKAGE,
        appName: SPOTIFY_APP_NAME,
        status: "Nothing is playing on Spotify.",
        notice,
      };
    }
    const item = playback.item;
    const restricted = playback.device?.restricted === true;
    const allowed = (action: string) => !restricted && !playback.disallows.includes(action);
    const state: MediaControllerState = {
      available: true,
      accessEnabled: true,
      packageName: SPOTIFY_PACKAGE,
      appName: spotifyAppName(playback.device),
      playbackState: playback.playing ? "playing" : "paused",
      title: item?.name ?? (playback.playingType === "ad" ? "Advertisement" : ""),
      artist: item?.artists ?? "",
      album: item?.album ?? "",
      positionMs: item ? playback.progressMs : -1,
      durationMs: item?.durationMs ?? -1,
      playbackSpeed: playback.playing ? 1 : 0,
      status: "",
      canPlayPause: allowed(playback.playing ? "pausing" : "resuming"),
      canSkipNext: allowed("skipping_next"),
      canSkipPrevious: allowed("skipping_prev"),
      artVersion: this.artVersion,
      customActions: restricted ? [] : this.customActions(playback),
      notice,
    };
    return interpolateMediaState(state, this.fetchedAtMs, this.now());
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async playPause(): Promise<void> {
    const playback = this.playback;
    if (!playback?.playing) {
      await this.startPlayback({});
      return;
    }
    await this.command(() => this.deps.client.pause(), () => {
      playback.progressMs = this.snapshot().positionMs;
      playback.playing = false;
      this.fetchedAtMs = this.now();
    });
  }

  async skipNext(): Promise<void> {
    await this.command(() => this.deps.client.next());
  }

  async skipPrevious(): Promise<void> {
    await this.command(() => this.deps.client.previous());
  }

  /** Signed in; whether anything is playing is in the state. */
  hasAccess(): boolean {
    return this.deps.isSignedIn();
  }

  /** Sign-in happens from the Music app menu, which shows its progress. */
  async requestAccess(): Promise<boolean> {
    return this.hasAccess();
  }

  /**
   * Queue ids are positions in getQueue (0 = the current item). The Web API
   * has no jump, so this skips forward that many times.
   */
  async skipToQueueItem(id: number): Promise<void> {
    const steps = Math.round(id);
    if (steps <= 0 || steps > this.upcoming.length) return;
    await this.command(async () => {
      for (let step = 0; step < steps; step++) await this.deps.client.next();
    }, () => {
      const target = this.upcoming[steps - 1];
      if (this.playback && target) {
        this.playback.item = target;
        this.playback.progressMs = 0;
        this.fetchedAtMs = this.now();
        this.upcoming = this.upcoming.slice(steps);
        this.queueCurrentUri = target.uri;
        this.itemChanged(target);
      }
    });
  }

  getMediaVolumePercent(): number {
    const device = this.playback?.device ?? null;
    if (!usesDeviceVolume(device)) return this.deps.systemVolume.get();
    return this.volumeTarget ?? device!.volumePercent;
  }

  setMediaVolumePercent(volumePercent: number): void {
    const device = this.playback?.device ?? null;
    const volume = Math.max(0, Math.min(100, Math.round(volumePercent)));
    if (!usesDeviceVolume(device)) {
      this.deps.systemVolume.set(volume);
      return;
    }
    // Scrolling sends a value per step: keep one request in flight and send the latest after it.
    device!.volumePercent = volume;
    this.volumeTarget = volume;
    if (!this.volumeSending) void this.sendVolume(device!.id);
  }

  getAlbumArt(maxSize: number): GrayImage | null {
    const art = this.art;
    if (!art?.bytes) return null;
    const size = Math.round(maxSize);
    if (!art.decoded.has(size)) art.decoded.set(size, this.deps.decodeArt(art.bytes, size));
    return art.decoded.get(size) ?? null;
  }

  /**
   * The current item, then what Spotify will play next. Read on demand (the
   * Music app asks while it paints), so nothing else pays for the request; a
   * stale list stays up, minus the items already played, until the new one
   * arrives.
   */
  getQueue(): MediaQueueItem[] {
    const current = this.playback?.item;
    if (!current) return [];
    const age = this.now() - this.queueFetchedAtMs;
    if (!this.queueLoading && (age > QUEUE_MAX_AGE_MS || (this.queueCurrentUri !== current.uri && age > QUEUE_MIN_INTERVAL_MS))) {
      void this.loadQueue();
    }
    if (!this.queueCurrentUri) return [];
    if (this.queueCurrentUri !== current.uri) {
      const index = this.upcoming.findIndex((item) => item.uri === current.uri);
      if (index >= 0) {
        this.upcoming = this.upcoming.slice(index + 1);
        this.queueCurrentUri = current.uri;
      }
    }
    return [current, ...this.upcoming].map((item, index) => ({
      id: index,
      title: item.name,
      subtitle: item.artists,
      active: index === 0,
    }));
  }

  async sendCustomAction(action: string): Promise<void> {
    const playback = this.playback;
    if (!playback) return;
    const client = this.deps.client;
    if (action === "shuffle") {
      const shuffle = !playback.shuffle;
      await this.command(() => client.setShuffle(shuffle), () => {
        playback.shuffle = shuffle;
        // Shuffling reorders what comes next.
        this.queueFetchedAtMs = 0;
      });
    } else if (action === "repeat") {
      const repeat = REPEAT_NEXT[playback.repeat];
      await this.command(() => client.setRepeat(repeat), () => {
        playback.repeat = repeat;
      });
    } else if (action === "like") {
      const liked = this.liked;
      if (!liked || liked.value === null) return;
      const value = !liked.value;
      await this.command(() => (value ? client.saveToLibrary([liked.uri]) : client.removeFromLibrary([liked.uri])), () => {
        if (this.liked === liked) liked.value = value;
      });
    }
  }

  async refresh(): Promise<void> {
    await this.poll();
  }

  /**
   * Play something (a browsed item, a search result) or, with an empty
   * request, resume. With no active device, starts on one the account has
   * open (preferring a phone). Resolves to whether it worked; a failure is
   * left as the state's notice.
   */
  async startPlayback(request: SpotifyPlayRequest): Promise<boolean> {
    const client = this.deps.client;
    const playback = this.playback;
    const ok = await this.command(async () => {
      try {
        await client.play(request);
      } catch (error) {
        if (!(error instanceof SpotifyApiError) || error.reason !== "NO_ACTIVE_DEVICE") throw error;
        const device = pickDevice(await client.devices());
        if (!device) throw error;
        await client.play(request, device.id);
      }
    }, () => {
      this.lastPlayingAtMs = this.now();
      if (playback && this.playback === playback && !request.contextUri && !request.uris) {
        playback.playing = true;
        this.fetchedAtMs = this.now();
      }
    });
    return ok;
  }

  /** The account changed (signed in, out, or as someone else): forget the old account's state. */
  accountChanged(): void {
    this.playback = null;
    this.upcoming = [];
    this.queueCurrentUri = "";
    this.art = null;
    this.artVersion++;
    this.liked = null;
    this.lastPlayingAtMs = 0;
    this.emit(true);
    if (this.listeners.size) this.schedulePoll(0);
  }

  /** Show a message about a failed command in the state's notice for a few seconds. */
  showNotice(message: string): void {
    this.notice = message;
    this.noticeUntilMs = this.now() + NOTICE_MS;
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.emit(true);
    }, NOTICE_MS + 50);
    this.emit(true);
  }

  private currentNotice(): string {
    return this.notice && this.now() < this.noticeUntilMs ? this.notice : "";
  }

  private customActions(playback: SpotifyPlayback): MediaCustomAction[] {
    if (!playback.item) return [];
    const actions: MediaCustomAction[] = [];
    if (!playback.disallows.includes("toggling_shuffle")) {
      actions.push({ action: "shuffle", name: playback.shuffle ? "Shuffle: on" : "Shuffle: off" });
    }
    if (!playback.disallows.includes("toggling_repeat_context") || !playback.disallows.includes("toggling_repeat_track")) {
      actions.push({ action: "repeat", name: REPEAT_LABEL[playback.repeat] });
    }
    const liked = this.liked;
    if (playback.item.type === "track" && liked?.uri === playback.item.uri && liked.value !== null) {
      actions.push({ action: "like", name: liked.value ? "Unlike song" : "Like song" });
    }
    return actions;
  }

  /** Run a command; on success apply its expected effect at once, then re-read to confirm. */
  private async command(run: () => Promise<void>, applied?: () => void): Promise<boolean> {
    let ok = false;
    try {
      await run();
      ok = true;
      applied?.();
      this.emit(true);
    } catch (error) {
      this.showNotice(errorMessage(error));
    }
    this.settlePolls = SETTLE_POLLS;
    this.schedulePoll(SETTLE_POLL_MS);
    return ok;
  }

  private async sendVolume(deviceId: string): Promise<void> {
    this.volumeSending = true;
    try {
      while (this.volumeTarget !== null) {
        const volume = this.volumeTarget;
        try {
          await this.deps.client.setVolume(volume, deviceId);
        } catch (error) {
          this.showNotice(errorMessage(error));
        }
        if (this.volumeTarget === volume) this.volumeTarget = null;
      }
    } finally {
      this.volumeSending = false;
    }
  }

  private poll(): Promise<void> {
    if (this.polling) {
      this.pollAgain = true;
      return this.polling;
    }
    this.polling = this.pollOnce().finally(() => {
      this.polling = null;
      if (this.pollAgain) {
        this.pollAgain = false;
        void this.poll();
      }
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    this.clearPollTimer();
    if (!this.deps.isSignedIn()) {
      if (this.playback) {
        this.playback = null;
        this.emit(true);
      }
      return;
    }
    let delay: number;
    try {
      const playback = await this.deps.client.playback();
      this.fetchedAtMs = this.now();
      this.applyPlayback(playback);
      delay = this.nextPollDelay(playback);
    } catch (error) {
      if (!(error instanceof SpotifyApiError) || error.reason !== "signed_out") {
        console.warn(`[spotify] playback read failed: ${error}`);
      }
      // Revoked access signs out (SpotifySession); the account listener resets the state.
      delay = POLL_ERROR_MS;
    }
    if (this.settlePolls > 0) {
      this.settlePolls--;
      delay = Math.min(delay, 1_500);
    }
    this.emit(false);
    this.schedulePoll(delay);
  }

  private applyPlayback(playback: SpotifyPlayback | null): void {
    const previousUri = this.playback?.item?.uri ?? "";
    this.playback = playback;
    if (playback?.playing) this.lastPlayingAtMs = this.now();
    const item = playback?.item ?? null;
    if ((item?.uri ?? "") !== previousUri) this.itemChanged(item);
  }

  /** A new item: fetch its art and whether it is liked. */
  private itemChanged(item: SpotifyItem | null): void {
    const url = item ? pickArtUrl(item) : "";
    if (url !== (this.art?.url ?? "")) {
      this.artVersion++;
      this.art = url ? { url, bytes: null, decoded: new Map() } : null;
      if (url) void this.loadArt(url);
    }
    this.liked = item?.type === "track" ? { uri: item.uri, value: null } : null;
    if (item?.type === "track") void this.loadLiked(item.uri);
  }

  private async loadArt(url: string): Promise<void> {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await this.deps.download(url);
    } catch (error) {
      console.warn(`[spotify] album art download failed: ${error}`);
    }
    if (!bytes?.length || this.art?.url !== url) return;
    this.art.bytes = bytes;
    this.artVersion++;
    this.emit(true);
  }

  private async loadLiked(uri: string): Promise<void> {
    try {
      const [value] = await this.deps.client.libraryContains([uri]);
      if (this.liked?.uri !== uri) return;
      this.liked.value = Boolean(value);
      this.emit(true);
    } catch (error) {
      console.warn(`[spotify] library check failed: ${error}`);
    }
  }

  private async loadQueue(): Promise<void> {
    this.queueLoading = true;
    try {
      const queue = await this.deps.client.queue();
      this.upcoming = queue.upcoming;
      this.queueCurrentUri = queue.current?.uri ?? "";
      this.queueFetchedAtMs = this.now();
      this.emit(true);
    } catch (error) {
      console.warn(`[spotify] queue read failed: ${error}`);
      this.queueFetchedAtMs = this.now();
    } finally {
      this.queueLoading = false;
    }
  }

  private nextPollDelay(playback: SpotifyPlayback | null): number {
    if (!playback) return POLL_IDLE_MS;
    if (!playback.playing) return POLL_PAUSED_MS;
    const durationMs = playback.item?.durationMs ?? -1;
    // Catch the change to the next track as it happens.
    const remaining = durationMs > 0 ? durationMs - playback.progressMs + 700 : POLL_PLAYING_MS;
    return Math.max(1_000, Math.min(POLL_PLAYING_MS, remaining));
  }

  private schedulePoll(delayMs: number): void {
    if (!this.listeners.size && !this.settlePolls) return;
    this.clearPollTimer();
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delayMs);
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** Tell listeners; unforced, only when something they draw (other than the advancing position) changed. */
  private emit(force: boolean): void {
    if (!this.listeners.size) return;
    const state = this.snapshot();
    const signature = JSON.stringify({ ...state, positionMs: 0 });
    if (!force && signature === this.lastSignature) return;
    this.lastSignature = signature;
    for (const listener of this.listeners) listener(state);
  }
}

/** "Spotify", or "Spotify · <device>" when it plays elsewhere than a phone. */
export function spotifyAppName(device: SpotifyDevice | null): string {
  if (!device?.name || device.type === "Smartphone") return SPOTIFY_APP_NAME;
  return `${SPOTIFY_APP_NAME} · ${device.name}`;
}

/** Spotify sets a speaker's or computer's volume; a phone's (this one) goes through the system volume. */
function usesDeviceVolume(device: SpotifyDevice | null): boolean {
  return Boolean(device && device.type !== "Smartphone" && device.supportsVolume && device.volumePercent >= 0 && device.id);
}

/** A device to start playback on when none is active: an open one, a phone first. */
export function pickDevice(devices: SpotifyDevice[]): SpotifyDevice | null {
  const usable = devices.filter((device) => device.id && !device.restricted);
  return usable.find((device) => device.active)
    ?? usable.find((device) => device.type === "Smartphone")
    ?? usable[0]
    ?? null;
}

function pickArtUrl(item: SpotifyItem): string {
  const images = [...item.images].sort((a, b) => a.width - b.width);
  return (images.find((image) => image.width >= ART_MIN_WIDTH) ?? images[images.length - 1])?.url ?? "";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
