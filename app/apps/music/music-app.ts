import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { directionalFallback, GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL_DOWN, GESTURE_SCROLL_UP, type InputEvent, isDirectionalInput } from "../../ui/gestures";
import { MenuLayer, drawSelectionHighlight, drawSubmenuIndicator } from "../../ui/menu";
import { lineStep, tightRowHeight } from "../../ui/metrics";
import { mediaControllerBridge, type MediaControllerState, type MediaQueueItem } from "../../native/media-controller";
import { mediaBrowserBridge, type MediaBrowserApp } from "../../native/media-browser";
import { MediaBrowseLayer } from "./media-browse";
import { Layer, type LayerContext, type PaintBelow } from "../../ui/layers";
import { createInProcessWindow, YieldAtRootLayer, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";

export const MUSIC_WINDOW_ID = "music";
export const MUSIC_SURFACE_ID = "window:music";

const ART_SIZE = 112;
const ART_X = 8; // left margin matches the top margin
const ART_Y = 8;
const META_X = ART_X + ART_SIZE + 14;
const PROGRESS_TIME_Y = ART_Y + 100;
const PROGRESS_BAR_Y = ART_Y + 116;
const LIST_TOP = 136;
/** Gap between the menus' last row band and the viewport bottom. */
const LIST_BOTTOM_MARGIN = 4;
const ACTION_X = 22;
const ACTION_WIDTH = 154;
const COLUMN_DIVIDER_X = 190;
const QUEUE_X = 204;
const PLAYLIST_ACTION_INDEX = 1;

type MusicAction =
  | { kind: "play-pause"; label: string; enabled: boolean }
  | { kind: "previous"; label: string; enabled: boolean }
  | { kind: "next"; label: string; enabled: boolean }
  | { kind: "volume"; label: string; enabled: boolean }
  | { kind: "playlist"; label: string; enabled: boolean }
  | { kind: "browse"; label: string; enabled: boolean };

type FocusColumn = "actions" | "playlist";

/**
 * Music controller app: metadata + album art + transport controls for the
 * active Android media session (any player that publishes one), plus the
 * player's queue when it exposes one (scroll to a track, click to jump).
 */
class MusicAppLayer implements Layer {
  // Watch swipes skip tracks: right = next, left = previous.
  readonly acceptsDirectional = true;
  private focusColumn: FocusColumn = "actions";
  private selectedActionIndex = 0;
  private selectedQueueIndex = 0;
  private queueScrollRow = 0;
  private art: GrayImage | null = null;
  private artKey = "";

  isPlaylistFocused(): boolean {
    return this.focusColumn === "playlist";
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const media = mediaControllerBridge.snapshot();

    if (!media.accessEnabled) {
      const lines = wrapText(
        font,
        "Notification access is required before Android exposes media sessions. Click to open settings.",
        width - 48,
      );
      for (let index = 0; index < lines.length; index++) {
        image.drawText(font, 24, 16 + index * lineStep(font), lines[index]!, 180);
      }
      image.drawText(font, 20, height - 16, `${GESTURE_CLICK} open settings`, 110);
      return image;
    }

    if (!media.available) {
      image.drawText(font, 24, 16, "No active media session.", 180);
      if (mediaBrowserBridge.listBrowsableApps().length) {
        image.drawText(font, 24, 22 + lineStep(font), "Click to browse a music app's library,", 150);
        image.drawText(font, 24, 22 + 2 * lineStep(font), "or start playback on the phone.", 150);
        image.drawText(font, 20, height - 16, `${GESTURE_CLICK} browse`, 110);
      } else {
        image.drawText(font, 24, 22 + lineStep(font), "Start playback in another app on the phone.", 150);
      }
      return image;
    }

    this.drawArt(image, media);

    const metaWidth = width - META_X - 24;
    const metaStep = lineStep(font) + 1;
    const metaTop = ART_Y + 2;
    // Line budget above the progress-bar time line: the layout is five slots
    // (title, second title line, artist, album, player app); when the font is
    // too large for all five, the title gets one truncated line instead of
    // wrapping to two, and the rest shift up a slot.
    const maxLines = Math.floor((PROGRESS_TIME_Y - metaTop - 4 - font.lineHeight) / metaStep) + 1;
    const titleSlots = maxLines >= 5 ? 2 : 1;
    const title = media.title || "Unknown title";
    const titleLines =
      titleSlots === 2 ? wrapText(font, title, metaWidth).slice(0, 2) : [truncateText(font, title, metaWidth)];
    for (let index = 0; index < titleLines.length; index++) {
      image.drawText(font, META_X, metaTop + index * metaStep, titleLines[index]!, 230);
    }
    image.drawText(font, META_X, metaTop + 4 + titleSlots * metaStep, media.artist || "Unknown artist", 180);
    if (media.album) {
      image.drawText(font, META_X, metaTop + 4 + (titleSlots + 1) * metaStep, truncateText(font, media.album, metaWidth), 150);
    }
    image.drawText(
      font,
      META_X,
      metaTop + 4 + (titleSlots + 2) * metaStep,
      truncateText(font, media.appName || media.packageName, metaWidth),
      110,
    );
    this.drawProgress(image, media, metaWidth);

    const queue = mediaControllerBridge.getQueue();
    const actions = this.buildActions(media, queue);
    this.reconcileSelection(actions, queue);
    const listHeight = height - LIST_TOP - LIST_BOTTOM_MARGIN;
    const rowH = tightRowHeight(font);
    const visibleRows = Math.max(1, (listHeight / rowH) | 0);
    if (this.selectedQueueIndex < this.queueScrollRow) {
      this.queueScrollRow = this.selectedQueueIndex;
    } else if (this.selectedQueueIndex >= this.queueScrollRow + visibleRows) {
      this.queueScrollRow = this.selectedQueueIndex - visibleRows + 1;
    }
    this.queueScrollRow = clamp(this.queueScrollRow, 0, Math.max(0, queue.length - visibleRows));

    for (let index = 0; index < actions.length; index++) {
      const action = actions[index]!;
      const y = LIST_TOP + index * rowH;
      const selected = index === this.selectedActionIndex;
      const highlightX = ACTION_X - 6;
      const highlightY = y - 1;
      const highlightWidth = ACTION_WIDTH + 8;
      const highlightHeight = rowH - 1;
      if (selected) {
        drawSelectionHighlight(
          image,
          highlightX,
          highlightY,
          highlightWidth,
          highlightHeight,
          ctx.stack.isFocused() && this.focusColumn === "actions",
          4,
        );
      }
      const value = !action.enabled ? (selected ? 130 : 90) : selected ? 255 : 200;
      image.drawText(font, ACTION_X, y + 1, truncateText(font, action.label, ACTION_WIDTH - 16), value);
      if ((action.kind === "playlist" || action.kind === "browse") && action.enabled) {
        drawSubmenuIndicator(image, font, highlightX, highlightY, highlightWidth, highlightHeight, value);
      }
    }

    image.drawLine(COLUMN_DIVIDER_X, LIST_TOP - 3, COLUMN_DIVIDER_X, height - LIST_BOTTOM_MARGIN - 3, 45);
    if (!queue.length) {
      image.drawText(font, QUEUE_X, LIST_TOP + 1, "Playlist unavailable", 90);
    } else {
      const queueWidth = width - QUEUE_X - 20;
      const lastVisible = Math.min(queue.length, this.queueScrollRow + visibleRows);
      for (let index = this.queueScrollRow; index < lastVisible; index++) {
        const item = queue[index]!;
        const y = LIST_TOP + (index - this.queueScrollRow) * rowH;
        const selected = index === this.selectedQueueIndex;
        if (selected) {
          drawSelectionHighlight(
            image,
            QUEUE_X - 6,
            y - 1,
            queueWidth + 8,
            rowH - 1,
            ctx.stack.isFocused() && this.focusColumn === "playlist",
            4,
          );
        }
        const label = `${item.active ? "> " : "  "}${item.title || "(untitled)"}`;
        image.drawText(font, QUEUE_X, y + 1, truncateText(font, label, queueWidth - 4), selected ? 255 : 200);
      }
      if (queue.length > visibleRows) {
        const trackHeight = visibleRows * rowH - 4;
        const trackX = width - 12;
        image.fillRect(trackX, LIST_TOP, 3, trackHeight, 30);
        const thumbHeight = Math.max(8, (trackHeight * visibleRows / queue.length) | 0);
        const maxScrollRow = queue.length - visibleRows;
        const thumbY = LIST_TOP + (((trackHeight - thumbHeight) * this.queueScrollRow / maxScrollRow) | 0);
        image.fillRect(trackX, thumbY, 3, thumbHeight, 120);
      }
    }

    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click" && this.focusColumn === "playlist") {
      this.focusColumn = "actions";
      this.selectedActionIndex = PLAYLIST_ACTION_INDEX;
      return;
    }
    const media = mediaControllerBridge.snapshot();
    if ((!media.accessEnabled || !media.available) && isDirectionalInput(event)) {
      // Nothing to skip between yet: the setup prompts take select / back.
      return this.handleInput(directionalFallback(event), ctx);
    }
    if (!media.accessEnabled) {
      if (event.type === "click") {
        mediaControllerBridge.openNotificationAccessSettings();
      } else if (event.type === "double-click") {
        ctx.stack.pop();
      }
      return;
    }
    if (!media.available) {
      if (event.type === "click") {
        this.openBrowse(ctx);
      }
      return;
    }
    const queue = mediaControllerBridge.getQueue();
    const actions = this.buildActions(media, queue);
    this.reconcileSelection(actions, queue);
    switch (event.type) {
      case "swipe-right":
        if (media.canSkipNext) await mediaControllerBridge.skipNext();
        return;
      case "swipe-left":
        if (media.canSkipPrevious) await mediaControllerBridge.skipPrevious();
        return;
      case "swipe-up":
        return this.handleInput({ type: "scroll-up", timestampMs: event.timestampMs }, ctx);
      case "swipe-down":
        return this.handleInput({ type: "scroll-down", timestampMs: event.timestampMs }, ctx);
      case "scroll-up":
        if (this.focusColumn === "playlist") {
          this.selectedQueueIndex = Math.max(0, this.selectedQueueIndex - 1);
        } else {
          this.selectedActionIndex = (this.selectedActionIndex + actions.length - 1) % actions.length;
        }
        return;
      case "scroll-down":
        if (this.focusColumn === "playlist") {
          this.selectedQueueIndex = Math.min(Math.max(0, queue.length - 1), this.selectedQueueIndex + 1);
        } else {
          this.selectedActionIndex = (this.selectedActionIndex + 1) % actions.length;
        }
        return;
      case "click": {
        if (this.focusColumn === "playlist") {
          const item = queue[this.selectedQueueIndex];
          if (item) {
            await mediaControllerBridge.skipToQueueItem(item.id);
            // The player rebuilds the queue with the chosen track at index 0.
            this.selectedQueueIndex = 0;
            this.queueScrollRow = 0;
          }
          return;
        }
        const action = actions[this.selectedActionIndex];
        if (!action || !action.enabled) return;
        if (action.kind === "play-pause") await mediaControllerBridge.playPause();
        else if (action.kind === "previous") await mediaControllerBridge.skipPrevious();
        else if (action.kind === "next") await mediaControllerBridge.skipNext();
        else if (action.kind === "browse") this.openBrowse(ctx);
        else if (action.kind === "volume") {
          ctx.stack.push(new VolumeModalLayer(mediaControllerBridge.getMediaVolumePercent()));
        } else if (action.kind === "playlist") {
          const activeIndex = queue.findIndex((item) => item.active);
          if (activeIndex >= 0) this.selectedQueueIndex = activeIndex;
          this.focusColumn = "playlist";
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Open the media-library browser (the Android Auto MediaBrowserService
   * path): with one browsable player installed go straight to its library,
   * otherwise offer a picker first.
   */
  private openBrowse(ctx: LayerContext): void {
    const apps = mediaBrowserBridge.listBrowsableApps(true);
    if (!apps.length) return;
    const pushBrowser = (target: LayerContext, app: MediaBrowserApp) => {
      target.stack.push(
        new MediaBrowseLayer({
          app,
          onPlayed: (browseCtx) => browseCtx.stack.pop(),
          onLeave: (browseCtx) => browseCtx.stack.pop(),
        }),
      );
    };
    if (apps.length === 1) {
      pushBrowser(ctx, apps[0]!);
      return;
    }
    ctx.stack.push(
      new MenuLayer(
        "Browse library",
        apps.map((app) => ({
          label: app.appName,
          onSelect: (menuCtx: LayerContext) => {
            menuCtx.stack.pop();
            pushBrowser(menuCtx, app);
          },
        })),
      ),
    );
  }

  private buildActions(media: MediaControllerState, queue: MediaQueueItem[]): MusicAction[] {
    const volume = mediaControllerBridge.getMediaVolumePercent();
    return [
      {
        kind: "play-pause",
        label: media.playbackState === "playing" ? "Pause" : "Play",
        enabled: media.canPlayPause,
      },
      { kind: "playlist", label: "Playlist", enabled: queue.length > 0 },
      { kind: "browse", label: "Browse library", enabled: mediaBrowserBridge.listBrowsableApps().length > 0 },
      { kind: "volume", label: volume >= 0 ? `Volume (${volume})` : "Volume", enabled: volume >= 0 },
      { kind: "next", label: "Next track", enabled: media.canSkipNext },
      { kind: "previous", label: "Previous track", enabled: media.canSkipPrevious },
    ];
  }

  private reconcileSelection(actions: MusicAction[], queue: MediaQueueItem[]): void {
    this.selectedActionIndex = clamp(this.selectedActionIndex, 0, actions.length - 1);
    this.selectedQueueIndex = clamp(this.selectedQueueIndex, 0, Math.max(0, queue.length - 1));
    if (!queue.length && this.focusColumn === "playlist") {
      this.focusColumn = "actions";
      this.selectedActionIndex = PLAYLIST_ACTION_INDEX;
    }
  }

  private drawProgress(image: GrayImage, media: MediaControllerState, width: number): void {
    if (media.durationMs <= 0 || media.positionMs < 0) return;
    const font = getDefaultSmallFont();
    const elapsed = formatMediaTime(media.positionMs);
    const duration = formatMediaTime(media.durationMs);
    image.drawText(font, META_X, PROGRESS_TIME_Y, elapsed, 140);
    image.drawText(font, META_X + width - font.measureText(duration), PROGRESS_TIME_Y, duration, 140);

    const barY = PROGRESS_BAR_Y;
    image.drawRect(META_X, barY, width, 5, 55);
    const progress = clamp(media.positionMs / media.durationMs, 0, 1);
    image.fillRect(META_X + 1, barY + 1, Math.round((width - 2) * progress), 3, 170);
  }

  private drawArt(image: GrayImage, media: MediaControllerState): void {
    const key = `${media.packageName}|${media.title}|${media.album}`;
    // Retry while null: players (e.g. Spotify) often publish metadata before
    // the art bitmap is downloaded, then re-emit the same strings with the
    // bitmap attached. The no-art fetch path is a cheap near-no-op.
    if (key !== this.artKey || this.art === null) {
      this.artKey = key;
      this.art = mediaControllerBridge.getAlbumArt(ART_SIZE);
    }
    if (this.art) {
      // Center within the art box.
      const dx = ART_X + Math.max(0, ((ART_SIZE - this.art.width) / 2) | 0);
      const dy = ART_Y + Math.max(0, ((ART_SIZE - this.art.height) / 2) | 0);
      image.bitBlt(this.art, dx, dy);
      image.drawRect(dx - 1, dy - 1, this.art.width + 2, this.art.height + 2, 60);
    } else {
      image.drawRect(ART_X, ART_Y, ART_SIZE, ART_SIZE, 60);
      const font = getDefaultSmallFont();
      image.drawText(
        font,
        ART_X + Math.round((ART_SIZE - font.measureText("no art")) / 2),
        ART_Y + Math.round((ART_SIZE - font.lineHeight) / 2),
        "no art",
        90,
      );
    }
  }
}

/** Centered volume control overlay; scroll gestures adjust a 0..100 target by two. */
class VolumeModalLayer implements Layer {
  private volume: number;

  constructor(initialVolume: number) {
    this.volume = clamp(initialVolume, 0, 100);
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const { width, height } = ctx.stack.getBaseSize();
    const boxWidth = 340;
    const boxHeight = 150;
    const x = ((width - boxWidth) / 2) | 0;
    const y = ((height - boxHeight) / 2) | 0;

    image.fillRoundedRect(x, y, boxWidth, boxHeight, 1, 8);
    image.drawRoundedRect(x, y, boxWidth, boxHeight, 95, 8);
    image.drawText(small, x + 18, y + 14, "Media volume", 180);

    const value = `${this.volume} / 100`;
    const valueX = x + (((boxWidth - medium.measureText(value)) / 2) | 0);
    image.drawText(medium, valueX, y + 45, value, 245);

    const barX = x + 28;
    const barY = y + 83;
    const barWidth = boxWidth - 56;
    image.drawRect(barX, barY, barWidth, 9, 65);
    image.fillRect(barX + 1, barY + 1, Math.round((barWidth - 2) * this.volume / 100), 7, 175);

    const hint = `${GESTURE_SCROLL_UP} +2   ${GESTURE_SCROLL_DOWN} -2   ${GESTURE_DOUBLE_CLICK} done`;
    const hintX = x + (((boxWidth - small.measureText(hint)) / 2) | 0);
    image.drawText(small, hintX, y + 116, hint, 120);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "scroll-up") {
      this.adjust(2);
    } else if (event.type === "scroll-down") {
      this.adjust(-2);
    } else if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }

  private adjust(delta: number): void {
    this.volume = clamp(this.volume + delta, 0, 100);
    mediaControllerBridge.setMediaVolumePercent(this.volume);
  }
}

/** Let back leave the playlist column before the root wrapper yields to the shell. */
class MusicRootLayer implements Layer {
  readonly acceptsDirectional = true;
  private readonly yieldAtRoot: YieldAtRootLayer;

  constructor(private readonly music: MusicAppLayer) {
    this.yieldAtRoot = new YieldAtRootLayer(music);
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    return this.yieldAtRoot.paint(ctx, paintBelow);
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click" && this.music.isPlaylistFocused()) {
      await this.music.handleInput(event, ctx);
      return;
    }
    await this.yieldAtRoot.handleInput(event, ctx);
  }

  onRemoved(): void {
    this.yieldAtRoot.onRemoved();
  }
}

export function createMusicAppWindow(options: InProcessAppOptions): InProcessWindow {
  let unsubscribe: (() => void) | null = null;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  const musicLayer = new MusicAppLayer();
  const stopProgressTimer = () => {
    if (progressTimer !== null) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  };
  const app = createInProcessWindow({
    appId: "music",
    windowId: MUSIC_WINDOW_ID,
    title: "Music",
    iconLetter: "M",
    icon: "music",
    closeable: true,
    actions: options.actions,
    baseLayer: new MusicRootLayer(musicLayer),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      stopProgressTimer();
      unsubscribe?.();
      unsubscribe = null;
      options.onClosed();
    },
  });
  unsubscribe = mediaControllerBridge.onStateChange((state) => {
    if (state.playbackState === "playing" && state.durationMs > 0 && state.positionMs >= 0) {
      progressTimer ??= setInterval(() => app.requestRender(), 1_000);
    } else {
      stopProgressTimer();
    }
    app.requestRender();
  });
  return app;
}

function formatMediaTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
