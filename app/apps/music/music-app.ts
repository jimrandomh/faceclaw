import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { directionalFallback, GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL_DOWN, GESTURE_SCROLL_UP, type InputEvent, isDirectionalInput } from "../../ui/gestures";
import { MenuLayer, drawSubmenuIndicator } from "../../ui/menu";
import { Menu, type MenuDrawArgs } from "../../ui/menu-core";
import { centeredTextY, lineStep, tightRowHeight } from "../../ui/metrics";
import { mediaControllerBridge, type MediaControllerState, type MediaQueueItem } from "../../native/media-controller";
import { mediaBrowserBridge, type MediaBrowserApp } from "../../native/media-browser";
import { spotifyService } from "../../native/spotify";
import { MediaBrowseLayer } from "./media-browse";
import { MusicSettingsLayer } from "./music-settings";
import { spotifyMenuItem } from "./spotify-menu";
import { Layer, type LayerContext, type PaintBelow } from "../../ui/layers";
import { createInProcessWindow, YieldAtRootLayer, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";
import type { Viewport } from "../../ui/viewport";

export const MUSIC_WINDOW_ID = "music";
export const MUSIC_SURFACE_ID = "window:music";

const ART_SIZE = 112;
/**
 * The outline hugging the album art. It is the outermost thing the
 * now-playing page draws toward the window's top and left edges, so it sits
 * at the padding suggested for them and the art just inside it.
 */
const ART_FRAME = 1;
/** Gap between the art and the metadata column. */
const META_GAP = 14;
/** The metadata's first line, the progress bar and the lists, down from the art's top. */
const META_OFFSET_Y = 2;
const PROGRESS_BAR_OFFSET_Y = 116;
const LIST_OFFSET_Y = 128;
/** Clear rows between the time labels' baseline (digits have no descenders) and the bar. */
const PROGRESS_TIME_GAP = 3;
const ACTION_WIDTH = 154;
/** Horizontal inset of row text from its selection box. */
const LIST_TEXT_INSET = 6;
/** The actions column's selection boxes, which start at the window's left padding. */
const ACTION_BOX_WIDTH = ACTION_WIDTH + 2 * LIST_TEXT_INSET - 4;
/** The column divider and the queue's selection boxes, right of the actions column's left edge. */
const COLUMN_DIVIDER_OFFSET_X = 174;
const QUEUE_OFFSET_X = 182;
/** Width of the bar Menu.drawScrollbar draws, and the room kept for it right of a list's rows. */
const SCROLLBAR_WIDTH = 3;
const SCROLLBAR_GUTTER = 6;
/** How far the setup prompt's text is indented from its hint line. */
const PROMPT_INDENT = 4;
/** Gap between the no-session page's status line, its prompt and its list. */
const SECTION_GAP = 6;
const PLAYLIST_ACTION_INDEX = 1;
/** Minimum room for the dim artist after a queue row's title; less and it is left off. */
const QUEUE_SUBTITLE_MIN_WIDTH = 40;

type MusicAction =
  | { kind: "play-pause"; label: string; enabled: boolean }
  | { kind: "previous"; label: string; enabled: boolean }
  | { kind: "next"; label: string; enabled: boolean }
  | { kind: "volume"; label: string; enabled: boolean }
  | { kind: "playlist"; label: string; enabled: boolean }
  | { kind: "browse"; label: string; enabled: boolean }
  /** A player-specific action from the state's customActions (Spotify's shuffle / repeat / like). */
  | { kind: "custom"; label: string; enabled: boolean; action: string };

type FocusColumn = "actions" | "playlist";

/**
 * Music controller app: metadata + album art + transport controls for the
 * active Android media session (any player that publishes one) or, on iOS,
 * the Apple Music system player; on both, Spotify through its Web API once
 * signed in from the window menu (optional on Android, where it adds
 * library browsing, shuffle / repeat / like and Spotify on other devices),
 * plus the player's queue when it exposes one
 * (scroll to a track, click to jump). With no session, the front page lists
 * the apps whose library can be browsed (click one to open its
 * MediaBrowseLayer).
 */
class MusicAppLayer implements Layer {
  // Watch swipes skip tracks: right = next, left = previous.
  readonly acceptsDirectional = true;
  private focusColumn: FocusColumn = "actions";
  private readonly actionsMenu = new Menu<MusicAction>({
    wrap: true,
    rowGap: 1,
    highlight: { radius: 4 },
    getHeight: () => tightRowHeight(getDefaultSmallFont()),
    draw: (args) => this.drawAction(args),
  });
  private readonly queueMenu = new Menu<MediaQueueItem>({
    wrap: false,
    rowGap: 1,
    highlight: { radius: 4 },
    getHeight: () => tightRowHeight(getDefaultSmallFont()),
    draw: (args) => this.drawQueueItem(args),
  });
  /** The no-session front page's picker of apps whose library can be browsed. */
  private readonly libraryMenu = new Menu<MediaBrowserApp>({
    wrap: false,
    rowGap: 1,
    highlight: { radius: 4 },
    getHeight: () => tightRowHeight(getDefaultSmallFont()),
    draw: (args) => this.drawLibraryApp(args),
  });
  /**
   * Whether the browsable-app list has been re-queried since the no-session
   * page last appeared (apps installed since the cached query then show up).
   */
  private libraryAppsFresh = false;
  private art: GrayImage | null = null;
  /** The artVersion `art` was fetched for; -1 = not fetched yet. */
  private artVersion = -1;

  isPlaylistFocused(): boolean {
    return this.focusColumn === "playlist";
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const viewport = ctx.stack.getBaseSize();
    const { width, height, padding } = viewport;
    const image = new GrayImage(width, height, 0);
    const media = mediaControllerBridge.snapshot();

    if (!media.accessEnabled) {
      // The hint line sits at the window's left and bottom padding; the
      // prompt is indented from it, as far from the right padding as the left.
      const lines = wrapText(font, mediaControllerBridge.accessPrompt, width - padding.left - padding.right - 2 * PROMPT_INDENT);
      for (let index = 0; index < lines.length; index++) {
        image.drawText(font, padding.left + PROMPT_INDENT, padding.top + index * lineStep(font), lines[index]!, 180);
      }
      image.drawText(font, padding.left, height - padding.bottom - font.lineHeight, `${GESTURE_CLICK} ${mediaControllerBridge.accessAction}`, 110);
      return image;
    }

    // Lists' selection boxes start at the window's left padding and stop
    // short of the scrollbar, which hugs the right padding.
    const listX = padding.left;
    const rowsRight = width - padding.right - SCROLLBAR_GUTTER;
    const focused = ctx.stack.isFocused();

    if (!media.available) {
      const apps = mediaBrowserBridge.listBrowsableApps(!this.libraryAppsFresh);
      this.libraryAppsFresh = true;
      this.libraryMenu.setItems(apps);
      // The text lines up with the picker's row text.
      const textX = listX + LIST_TEXT_INSET;
      const textWidth = rowsRight - listX - 2 * LIST_TEXT_INSET;
      image.drawText(font, textX, padding.top, global.isIOS ? media.status || "Nothing is playing." : "No active media session.", 180);
      const prompt = global.isIOS
        ? "Browse your library, or start playback on the phone."
        : apps.length
          ? "Browse a music app's library, or start playback on the phone."
          : "Start playback in another app on the phone.";
      let y = padding.top + lineStep(font) + SECTION_GAP;
      for (const line of wrapText(font, prompt, textWidth)) {
        image.drawText(font, textX, y, line, 150);
        y += lineStep(font);
      }
      // Why the last command failed (e.g. playing from the Spotify library with no device open).
      for (const line of media.notice ? wrapText(font, media.notice, textWidth) : []) {
        image.drawText(font, textX, y, line, 200);
        y += lineStep(font);
      }
      if (apps.length) {
        paintListToBottomEdge(image, this.libraryMenu, { x: listX, top: y + SECTION_GAP, width: rowsRight - listX }, viewport, focused, true);
      }
      return image;
    }
    this.libraryAppsFresh = false;

    const artX = padding.left + ART_FRAME;
    const artY = padding.top + ART_FRAME;
    this.drawArt(image, media, artX, artY);

    // The metadata column and the progress bar end at the window's right padding.
    const metaX = artX + ART_SIZE + META_GAP;
    const metaWidth = width - padding.right - metaX;
    const metaStep = lineStep(font) + 1;
    const metaTop = artY + META_OFFSET_Y;
    const progressBarY = artY + PROGRESS_BAR_OFFSET_Y;
    // Line budget above the progress-bar time line: the layout is five slots
    // (title, second title line, artist, album, player app); when the font is
    // too large for all five, the title gets one truncated line instead of
    // wrapping to two, and the rest shift up a slot.
    const maxLines = Math.floor((progressTimeY(font, progressBarY) - metaTop - 4 - font.lineHeight) / metaStep) + 1;
    const titleSlots = maxLines >= 5 ? 2 : 1;
    const title = media.title || "Unknown title";
    const titleLines =
      titleSlots === 2 ? wrapText(font, title, metaWidth).slice(0, 2) : [truncateText(font, title, metaWidth)];
    for (let index = 0; index < titleLines.length; index++) {
      image.drawText(font, metaX, metaTop + index * metaStep, titleLines[index]!, 230);
    }
    image.drawText(font, metaX, metaTop + 4 + titleSlots * metaStep, media.artist || "Unknown artist", 180);
    if (media.album) {
      image.drawText(font, metaX, metaTop + 4 + (titleSlots + 1) * metaStep, truncateText(font, media.album, metaWidth), 150);
    }
    // The player line, or for a few seconds why a command failed.
    image.drawText(
      font,
      metaX,
      metaTop + 4 + (titleSlots + 2) * metaStep,
      truncateText(font, media.notice || media.appName || media.packageName, metaWidth),
      media.notice ? 200 : 110,
    );
    this.drawProgress(image, media, metaX, progressBarY, metaWidth);

    const queue = mediaControllerBridge.getQueue();
    const actions = this.buildActions(media, queue);
    this.reconcileSelection(actions, queue);
    const listTop = artY + LIST_OFFSET_Y;
    paintListToBottomEdge(image, this.actionsMenu, { x: listX, top: listTop, width: ACTION_BOX_WIDTH }, viewport,
      focused && this.focusColumn === "actions");

    // The divider is fixed, so it stops at the window's bottom padding.
    const dividerX = listX + COLUMN_DIVIDER_OFFSET_X;
    const dividerBottom = height - padding.bottom - 1;
    if (dividerBottom > listTop) image.drawLine(dividerX, listTop - 3, dividerX, dividerBottom, 45);
    const queueX = listX + QUEUE_OFFSET_X;
    if (!queue.length) {
      image.drawText(font, queueX + LIST_TEXT_INSET, listTop + 1, "Playlist unavailable", 90);
    } else {
      paintListToBottomEdge(image, this.queueMenu, { x: queueX, top: listTop, width: rowsRight - queueX }, viewport,
        focused && this.focusColumn === "playlist", true);
    }

    return image;
  }

  private drawAction({ image, item: action, x, y, width, height, selected }: MenuDrawArgs<MusicAction>): void {
    const font = getDefaultSmallFont();
    const value = !action.enabled ? (selected ? 130 : 90) : selected ? 255 : 200;
    image.drawText(font, x + LIST_TEXT_INSET, centeredTextY(font, y, height), truncateText(font, action.label, ACTION_WIDTH - 16), value);
    if ((action.kind === "playlist" || action.kind === "browse") && action.enabled) {
      drawSubmenuIndicator(image, font, x, y, width, height, value);
    }
  }

  private drawLibraryApp({ image, item: app, x, y, width, height, selected }: MenuDrawArgs<MediaBrowserApp>): void {
    const font = getDefaultSmallFont();
    const value = selected ? 255 : 200;
    image.drawText(font, x + LIST_TEXT_INSET, centeredTextY(font, y, height), truncateText(font, app.appName, width - 2 * LIST_TEXT_INSET - 16), value);
    drawSubmenuIndicator(image, font, x, y, width, height, value);
  }

  private drawQueueItem({ image, item, x, y, width, height, selected }: MenuDrawArgs<MediaQueueItem>): void {
    const font = getDefaultSmallFont();
    const label = `${item.active ? "> " : "  "}${item.title || "(untitled)"}`;
    const textWidth = width - 2 * LIST_TEXT_INSET;
    const textY = centeredTextY(font, y, height);
    const title = truncateText(font, label, textWidth);
    image.drawText(font, x + LIST_TEXT_INSET, textY, title, selected ? 255 : 200);
    // The artist, dimmer, in whatever room the title leaves.
    const subtitleX = font.measureText(`${label}  `);
    if (item.subtitle && title === label && textWidth - subtitleX >= QUEUE_SUBTITLE_MIN_WIDTH) {
      image.drawText(font, x + LIST_TEXT_INSET + subtitleX, textY,
        truncateText(font, item.subtitle, textWidth - subtitleX), selected ? 150 : 110);
    }
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click" && this.focusColumn === "playlist") {
      this.focusColumn = "actions";
      this.actionsMenu.select(PLAYLIST_ACTION_INDEX);
      return;
    }
    const media = mediaControllerBridge.snapshot();
    if ((!media.accessEnabled || !media.available) && isDirectionalInput(event)) {
      // Nothing to skip between yet: the setup prompts take select / back.
      return this.handleInput(directionalFallback(event), ctx);
    }
    if (!media.accessEnabled) {
      if (event.type === "click") {
        void mediaControllerBridge.requestAccess();
      } else if (event.type === "double-click") {
        ctx.stack.pop();
      }
      return;
    }
    if (!media.available) {
      this.libraryMenu.setItems(mediaBrowserBridge.listBrowsableApps());
      if (event.type === "scroll-up" || event.type === "scroll-down") {
        await this.libraryMenu.handleInput(event);
      } else if (event.type === "click") {
        const app = this.libraryMenu.selectedItem;
        if (app) this.pushLibraryBrowser(ctx, app);
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
      case "scroll-down":
        await (this.focusColumn === "playlist" ? this.queueMenu : this.actionsMenu).handleInput(event);
        return;
      case "click": {
        if (this.focusColumn === "playlist") {
          const item = this.queueMenu.selectedItem;
          if (item) {
            await mediaControllerBridge.skipToQueueItem(item.id);
            // Android players rebuild the queue with the chosen track at index 0.
            if (mediaControllerBridge.skipRebuildsQueue) this.queueMenu.select(0);
          }
          return;
        }
        const action = this.actionsMenu.selectedItem;
        if (!action || !action.enabled) return;
        if (action.kind === "play-pause") await mediaControllerBridge.playPause();
        else if (action.kind === "previous") await mediaControllerBridge.skipPrevious();
        else if (action.kind === "next") await mediaControllerBridge.skipNext();
        else if (action.kind === "browse") this.openBrowse(ctx);
        else if (action.kind === "custom") await mediaControllerBridge.sendCustomAction?.(action.action);
        else if (action.kind === "volume") {
          ctx.stack.push(new VolumeModalLayer(mediaControllerBridge.getMediaVolumePercent()));
        } else if (action.kind === "playlist") {
          const activeIndex = queue.findIndex((item) => item.active);
          if (activeIndex >= 0) this.queueMenu.select(activeIndex);
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
   * path) from the now-playing page: with one browsable player installed go
   * straight to its library, otherwise offer a picker first. (With no session
   * the picker is the front page itself.)
   */
  private openBrowse(ctx: LayerContext): void {
    const apps = mediaBrowserBridge.listBrowsableApps(true);
    if (!apps.length) return;
    if (apps.length === 1) {
      this.pushLibraryBrowser(ctx, apps[0]!);
      return;
    }
    ctx.stack.push(
      new MenuLayer(
        "Browse library",
        apps.map((app) => ({
          label: app.appName,
          onSelect: (menuCtx: LayerContext) => {
            menuCtx.stack.pop();
            this.pushLibraryBrowser(menuCtx, app);
          },
        })),
      ),
    );
  }

  private pushLibraryBrowser(ctx: LayerContext, app: MediaBrowserApp): void {
    ctx.stack.push(
      new MediaBrowseLayer({
        app,
        onPlayed: (browseCtx) => browseCtx.stack.pop(),
        onLeave: (browseCtx) => browseCtx.stack.pop(),
      }),
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
      ...(mediaControllerBridge.sendCustomAction ? media.customActions ?? [] : []).map((custom): MusicAction => ({
        kind: "custom",
        label: custom.name,
        enabled: true,
        action: custom.action,
      })),
    ];
  }

  /** Hand the menus the freshly built rows; each keeps its selection index, clamped. */
  private reconcileSelection(actions: MusicAction[], queue: MediaQueueItem[]): void {
    this.actionsMenu.setItems(actions);
    this.queueMenu.setItems(queue);
    if (!queue.length && this.focusColumn === "playlist") {
      this.focusColumn = "actions";
      this.actionsMenu.select(PLAYLIST_ACTION_INDEX);
    }
  }

  /** The elapsed/duration labels and, under them, the bar at (x, barY), `width` wide. */
  private drawProgress(image: GrayImage, media: MediaControllerState, x: number, barY: number, width: number): void {
    if (media.durationMs <= 0 || media.positionMs < 0) return;
    const font = getDefaultSmallFont();
    const elapsed = formatMediaTime(media.positionMs);
    const duration = formatMediaTime(media.durationMs);
    const timeY = progressTimeY(font, barY);
    image.drawText(font, x, timeY, elapsed, 140);
    image.drawText(font, x + width - font.measureText(duration), timeY, duration, 140);

    image.drawRect(x, barY, width, 5, 55);
    const progress = clamp(media.positionMs / media.durationMs, 0, 1);
    image.fillRect(x + 1, barY + 1, Math.round((width - 2) * progress), 3, 170);
  }

  /** The album art, or a placeholder, in the ART_SIZE box at (artX, artY), with its outline around it. */
  private drawArt(image: GrayImage, media: MediaControllerState, artX: number, artY: number): void {
    // Keyed on artVersion, not the strings: players (e.g. Spotify) publish
    // metadata before the art bitmap is downloaded, or with the previous
    // track's bitmap after a quick double skip, then re-emit the same
    // strings with the right bitmap attached.
    if (media.artVersion !== this.artVersion) {
      this.artVersion = media.artVersion;
      this.art = mediaControllerBridge.getAlbumArt(ART_SIZE);
    }
    if (this.art) {
      // Center within the art box.
      const dx = artX + Math.max(0, ((ART_SIZE - this.art.width) / 2) | 0);
      const dy = artY + Math.max(0, ((ART_SIZE - this.art.height) / 2) | 0);
      image.bitBlt(this.art, dx, dy);
      image.drawRect(dx - ART_FRAME, dy - ART_FRAME, this.art.width + 2 * ART_FRAME, this.art.height + 2 * ART_FRAME, 60);
    } else {
      // The placeholder's outline is where a full-size cover's would be.
      image.drawRect(artX - ART_FRAME, artY - ART_FRAME, ART_SIZE + 2 * ART_FRAME, ART_SIZE + 2 * ART_FRAME, 60);
      const font = getDefaultSmallFont();
      image.drawText(
        font,
        artX + Math.round((ART_SIZE - font.measureText("no art")) / 2),
        artY + Math.round((ART_SIZE - font.lineHeight) / 2),
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
    // Music settings choose among Android media apps (iOS has Apple Music
    // alone); Spotify's sign-in is optional on Android, where its media
    // session works without it.
    menuItems: () => {
      const spotify = spotifyService();
      return [
        ...(global.isIOS ? [] : [{
          label: "Music settings",
          onSelect: (ctx: LayerContext) => {
            ctx.stack.pop();
            ctx.stack.push(new MusicSettingsLayer());
          },
        }]),
        ...(spotify ? [spotifyMenuItem(spotify)] : []),
      ];
    },
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

/**
 * Paint a list that scrolls under fixed content: from `top` down to the
 * window's bottom edge, where a row cut off for scrolling meets the edge,
 * with that edge's padding inside the list after its last row. Selection
 * boxes start one pixel above `top`. The scrollbar, when asked for, stays
 * inside the window's right and bottom padding.
 */
function paintListToBottomEdge<T>(
  image: GrayImage,
  menu: Menu<T>,
  rows: { x: number; top: number; width: number },
  viewport: Viewport,
  focused: boolean,
  scrollbar = false,
): void {
  const { width, height, padding } = viewport;
  const boxTop = rows.top - 1;
  if (boxTop >= height || rows.width <= 0) return;
  menu.paint(image, { x: rows.x, y: boxTop, width: rows.width, height: height - boxTop, padBottom: padding.bottom }, focused);
  const trackHeight = height - padding.bottom - rows.top;
  if (scrollbar && trackHeight > 0) {
    menu.drawScrollbar(image, width - padding.right - SCROLLBAR_WIDTH, rows.top, trackHeight);
  }
}

/**
 * Line top of the elapsed/duration labels: their baseline sits a fixed gap
 * above the progress bar (at barY), so the labels hug the bar whatever the
 * font's height (a taller face grows upward into the metadata's line budget).
 */
function progressTimeY(font: UiFont, barY: number): number {
  return barY - PROGRESS_TIME_GAP - font.ascent;
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
