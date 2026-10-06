import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { PHOTO_GAMMA } from "../../native/image-files";
import { probeVideo, VideoPlayer, type VideoInfo, type VideoPlaybackState } from "../../native/video-player";
import { ConfigSettingBoolean, ConfigSettingEnum } from "../../ui/dashboard-settings";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { drawRightValueMenuItem, drawToggleMenuItem } from "../../ui/menu";
import { Menu, type MenuDrawArgs } from "../../ui/menu-core";
import { LIST_ROW_TEXT_INSET, lineStep, listRowHeight } from "../../ui/metrics";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { appViewportSize } from "../../ui/shell/geometry";
import {
  formatMediaTime,
  VIDEO_SIZES,
  videoHeightMode,
  videoRect,
  videoSizeLabel,
  type Rect,
  type VideoSize,
} from "./video-layout";

export const videoSizeSetting = new ConfigSettingEnum<VideoSize>({
  id: "video-size",
  label: "Size",
  storageKey: "video.size",
  defaultValue: "large",
  values: VIDEO_SIZES,
  formatValue: videoSizeLabel,
});

export const videoAudioSetting = new ConfigSettingBoolean({
  id: "video-audio",
  label: "Audio",
  storageKey: "video.audio",
  defaultValue: true,
  description: "Play the video's sound on the phone's current audio output.",
});

export const videoMonochromeSetting = new ConfigSettingBoolean({
  id: "video-monochrome",
  label: "Monochrome",
  storageKey: "video.monochrome",
  defaultValue: false,
  description: "Show only black and white: far less to send per frame, so a higher frame rate.",
});

/** How far one ring scroll seeks. */
const SEEK_STEP_MS = 10_000;
const MARGIN_X = 18;
const TITLE_Y = 10;
const PANEL_WIDTH = 340;

/**
 * One opened video: its probe result, the native player, and the window
 * glue. The window's base layer is the settings panel; playing pushes the
 * playback layer, and backing out of it (or the video ending) returns to the
 * panel with the position kept for Resume.
 */
class VideoSession {
  readonly probe: VideoInfo | { error: string };
  private player: VideoPlayer | null = null;
  private window: InProcessWindow | null = null;
  private playback: VideoPlaybackLayer | null = null;
  /** Where Resume starts; 0 = from the beginning. */
  resumeMs = 0;
  /** The last playback error, shown on the panel until the next Play. */
  error: string | null = null;

  constructor(
    readonly path: string,
    readonly title: string,
    readonly surfaceId: string,
  ) {
    this.probe = probeVideo(path);
  }

  get info(): VideoInfo | null {
    return "error" in this.probe ? null : this.probe;
  }

  attach(window: InProcessWindow): void {
    this.window = window;
  }

  isPlaying(): boolean {
    return this.player?.isPlaying() ?? false;
  }

  positionMs(): number {
    return this.player?.positionMs() ?? this.resumeMs;
  }

  /** Current rect for a size choice, in the viewport of the band that size plays in. */
  rectFor(size: VideoSize, viewport: { width: number; height: number }): Rect {
    const info = this.info;
    return videoRect(size, info ? { width: info.width, height: info.height } : viewport, viewport);
  }

  play(ctx: LayerContext, fromStart: boolean): void {
    const window = this.window;
    const info = this.info;
    if (!window || !info) return;
    this.error = null;
    const size = videoSizeSetting.get();
    window.setHeightMode(videoHeightMode(size));
    const viewport = ctx.stack.getBaseSize();
    const rect = this.rectFor(size, viewport);
    const player = this.ensurePlayer();
    this.playback = new VideoPlaybackLayer(this, rect, viewport);
    ctx.stack.push(this.playback);
    player.start({
      path: this.path,
      surfaceId: this.surfaceId,
      rect,
      monochrome: videoMonochromeSetting.get(),
      gamma: PHOTO_GAMMA,
      audio: info.hasAudio && videoAudioSetting.get(),
      startMs: fromStart ? 0 : this.resumeMs,
    });
  }

  togglePause(): void {
    const player = this.player;
    if (!player) return;
    if (player.isPlaying()) player.pause();
    else player.resume();
  }

  seekBy(deltaMs: number): void {
    const player = this.player;
    if (!player) return;
    const duration = this.info?.durationMs ?? 0;
    const target = Math.max(0, player.positionMs() + deltaMs);
    player.seekTo(duration > 0 ? Math.min(target, duration) : target);
  }

  /** The window went to the background or the screen went off: stop, keep the place. */
  pauseForHost(): void {
    if (!this.player?.isPlaying()) return;
    this.player.pause();
    // Paint the paused overlay now, so the retained surface shows it on return.
    this.window?.requestRender();
  }

  /** Leave the playback layer for the panel, remembering where to resume. */
  returnToPanel(resumeMs: number): void {
    const player = this.player;
    if (player) {
      player.pause();
      player.stop();
    }
    this.resumeMs = resumeMs;
    const window = this.window;
    const playback = this.playback;
    this.playback = null;
    if (window && playback) window.stack.popThrough(playback);
    window?.setHeightMode("min");
    window?.requestRender();
  }

  lastFrame(rect: Rect): GrayImage | null {
    return this.player?.lastFrame(rect.width, rect.height) ?? null;
  }

  release(): void {
    this.player?.release();
    this.player = null;
  }

  private ensurePlayer(): VideoPlayer {
    if (!this.player) {
      this.player = new VideoPlayer({
        onState: (state, positionMs) => this.onPlayerState(state, positionMs),
        onError: (message) => {
          this.error = message;
          this.returnToPanel(this.positionMs());
        },
      });
    }
    return this.player;
  }

  private onPlayerState(state: VideoPlaybackState, _positionMs: number): void {
    if (state === "ended") {
      this.returnToPanel(0);
      return;
    }
    // A paused seek decoded its new frame: repaint it under the overlay.
    if (state === "paused") this.window?.requestRender();
  }
}

type PanelRow = { kind: "size" } | { kind: "audio" } | { kind: "monochrome" } | { kind: "play"; fromStart: boolean };

/**
 * The pre-play settings panel (the window's root): picture size, audio and
 * monochrome, all remembered for the next video, then Play (or Resume plus
 * Play from start once a position is kept).
 */
class VideoSettingsLayer implements Layer {
  private readonly menu = new Menu<PanelRow>({
    wrap: false,
    rowGap: 1,
    highlight: { radius: 6 },
    getHeight: () => listRowHeight(getDefaultSmallFont()),
    draw: (args) => this.drawRow(args),
  });
  constructor(private readonly session: VideoSession) {}

  private rows(): PanelRow[] {
    if (!this.session.info) return [];
    const rows: PanelRow[] = [{ kind: "size" }, { kind: "audio" }, { kind: "monochrome" }];
    rows.push({ kind: "play", fromStart: false });
    if (this.session.resumeMs > 0) rows.push({ kind: "play", fromStart: true });
    return rows;
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    image.drawText(font, MARGIN_X, TITLE_Y, truncateText(font, this.session.title, width - 2 * MARGIN_X), 220);
    const step = lineStep(font);
    let y = TITLE_Y + step;

    const info = this.session.info;
    const errors: string[] = [];
    if (!info) errors.push(`Can't play this video: ${(this.session.probe as { error: string }).error}`);
    if (this.session.error) errors.push(`Playback stopped: ${this.session.error}`);
    if (info) {
      const facts = [`${info.width}x${info.height}`, formatMediaTime(info.durationMs), info.hasAudio ? "sound" : "no sound"];
      image.drawText(font, MARGIN_X, y, facts.join(" · "), 130);
      y += step;
    }
    for (const error of errors) {
      for (const line of wrapText(font, error, width - 2 * MARGIN_X, { breakLongWords: true }).slice(0, 3)) {
        image.drawText(font, MARGIN_X, y, line, 200);
        y += step;
      }
    }
    y += 6;

    const rows = this.rows();
    const selected = this.menu.selectedItem;
    const index = selected ? rows.findIndex((row) => sameRow(row, selected)) : -1;
    // Land on Resume/Play by default: the settings usually stay as they were.
    const playIndex = rows.findIndex((row) => row.kind === "play");
    this.menu.setItems(rows, index >= 0 ? index : playIndex >= 0 ? playIndex : undefined);
    const panelWidth = Math.min(PANEL_WIDTH, width - 2 * (MARGIN_X - 6));
    this.menu.paint(image, { x: MARGIN_X - 6, y, width: panelWidth, height: Math.max(0, height - y - 4) },
      ctx.stack.isFocused());
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    switch (event.type) {
      case "scroll-up":
      case "scroll-down":
        await this.menu.handleInput(event);
        return;
      case "click": {
        const row = this.menu.selectedItem;
        if (row) this.activate(row, ctx);
        return;
      }
      default:
        return;
    }
  }

  private activate(row: PanelRow, ctx: LayerContext): void {
    switch (row.kind) {
      case "size":
        videoSizeSetting.set(videoSizeSetting.next());
        return;
      case "audio":
        if (this.session.info?.hasAudio) videoAudioSetting.toggle();
        return;
      case "monochrome":
        videoMonochromeSetting.toggle();
        return;
      case "play":
        this.session.play(ctx, row.fromStart);
        return;
    }
  }

  private drawRow({ image, item, x, y, width, selected }: MenuDrawArgs<PanelRow>): void {
    const font = getDefaultSmallFont();
    const textX = x + 10;
    const textWidth = width - 20;
    switch (item.kind) {
      case "size": {
        const size = videoSizeSetting.get();
        // The picture size this choice gets in its own band (full screen plays in the tall window).
        const rect = this.session.rectFor(size, appViewportSize(videoHeightMode(size)));
        drawRightValueMenuItem(image, font, textX, y, textWidth, "Size",
          `${videoSizeLabel(size)} ${rect.width}x${rect.height}`);
        return;
      }
      case "audio": {
        const hasAudio = this.session.info?.hasAudio ?? false;
        drawToggleMenuItem(image, font, textX, y, textWidth, hasAudio ? "Audio" : "Audio (none in file)",
          hasAudio && videoAudioSetting.get(), selected);
        return;
      }
      case "monochrome":
        drawToggleMenuItem(image, font, textX, y, textWidth, "Monochrome", videoMonochromeSetting.get(), selected);
        return;
      case "play": {
        const resumeMs = this.session.resumeMs;
        const label = item.fromStart ? "Play from start" : resumeMs > 0 ? `Resume from ${formatMediaTime(resumeMs)}` : "Play";
        image.drawText(font, textX, y + LIST_ROW_TEXT_INSET, label, selected ? 255 : 200);
        return;
      }
    }
  }
}

function sameRow(a: PanelRow, b: PanelRow): boolean {
  return a.kind === b.kind && (a.kind !== "play" || b.kind !== "play" || a.fromStart === b.fromStart);
}

/**
 * The playing video. The native player draws frames into the video rect on
 * its own; this layer paints only when the window renders (input, pause,
 * focus): black around the latest frame, plus a status box while paused.
 * Click pauses/resumes, scroll seeks 10s, double-click returns to the panel.
 */
class VideoPlaybackLayer implements Layer {
  private leaving = false;

  constructor(
    private readonly session: VideoSession,
    private readonly rect: Rect,
    /** The viewport the rect was laid out in. */
    private readonly viewport: { width: number; height: number },
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    if ((width !== this.viewport.width || height !== this.viewport.height) && !this.leaving) {
      // The window was relaid out (display mode change) and the native player's rect no
      // longer fits the surface: back out to the panel, which lays out afresh on Play.
      this.leaving = true;
      setTimeout(() => this.session.returnToPanel(this.session.positionMs()), 0);
    }
    const image = new GrayImage(width, height, 0);
    const frame = this.session.lastFrame(this.rect);
    if (frame) image.bitBlt(frame, this.rect.x, this.rect.y);
    if (!this.session.isPlaying()) this.drawPausedBox(image, frame === null);
    return image;
  }

  async handleInput(event: InputEvent): Promise<void> {
    switch (event.type) {
      case "click":
        this.session.togglePause();
        return;
      case "scroll-up":
        this.session.seekBy(-SEEK_STEP_MS);
        return;
      case "scroll-down":
        this.session.seekBy(SEEK_STEP_MS);
        return;
      case "double-click":
        this.session.returnToPanel(this.session.positionMs());
        return;
      default:
        return;
    }
  }

  /**
   * "Paused 1:23 / 3:52" over a progress bar, below the picture when there is
   * room (small sizes), else over its bottom edge.
   */
  private drawPausedBox(image: GrayImage, loading: boolean): void {
    const font = getDefaultSmallFont();
    const duration = this.session.info?.durationMs ?? 0;
    const position = this.session.positionMs();
    const text = loading ? "Loading..." : `Paused ${formatMediaTime(position)} / ${formatMediaTime(duration)}`;
    const boxWidth = Math.min(image.width - 8, font.measureText(text) + 24);
    const boxHeight = font.lineHeight + 14;
    const rect = this.rect;
    const x = Math.round(rect.x + (rect.width - boxWidth) / 2);
    const below = rect.y + rect.height + 4;
    const y = below + boxHeight <= image.height ? below : Math.max(0, rect.y + rect.height - boxHeight - 6);
    image.fillRoundedRect(x, y, boxWidth, boxHeight, 1, 6);
    image.drawRoundedRect(x, y, boxWidth, boxHeight, 72, 6);
    image.drawText(font, x + 12, y + 5, text, 220);
    if (!loading && duration > 0) {
      const barWidth = boxWidth - 24;
      image.fillRect(x + 12, y + boxHeight - 5, barWidth, 2, 40);
      image.fillRect(x + 12, y + boxHeight - 5, Math.round((barWidth * Math.min(position, duration)) / duration), 2, 200);
    }
  }
}

/** A video file's player as its own window, opened from the Files app. */
export function createVideoPlayerWindow(
  windowId: string,
  title: string,
  path: string,
  options: InProcessAppOptions,
): InProcessWindow {
  const session = new VideoSession(path, title, `window:${windowId}`);
  const window = createInProcessWindow({
    appId: "files",
    windowId,
    title,
    iconLetter: "V",
    icon: "film",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new VideoSettingsLayer(session)),
    // A playing video is the thing being watched: no idle screen-off.
    keepsScreenOn: () => session.isPlaying(),
    onForegroundChanged: (foreground) => {
      if (!foreground) session.pauseForHost();
    },
    setScreenOn: (on) => {
      if (!on) session.pauseForHost();
    },
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    reconfigureSurface: options.reconfigureSurface,
    onClosed: () => {
      session.release();
      options.onClosed();
    },
  });
  session.attach(window);
  return window;
}
