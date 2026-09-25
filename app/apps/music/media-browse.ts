import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, type InputEvent } from "../../ui/gestures";
import { MenuLayer, drawSubmenuIndicator } from "../../ui/menu";
import { Menu, type MenuDrawArgs } from "../../ui/menu-core";
import { centeredTextY, lineStep, tightRowHeight } from "../../ui/metrics";
import {
  mediaBrowserBridge,
  type MediaBrowseItem,
  type MediaBrowserApp,
} from "../../native/media-browser";
import { Layer, type LayerContext } from "../../ui/layers";

/** Header: title line + path line (34px at the 12px bitmap default). */
function headerHeight(font: UiFont): number {
  return 8 + lineStep(font) + font.lineHeight;
}
const LIST_X = 20;
/** The selection box extends this far left and right of the row text. */
const LIST_HIGHLIGHT_PAD = 6;

export type MediaBrowseOptions = {
  app: MediaBrowserApp;
  /** Called after playback of a picked item has been requested. */
  onPlayed: (ctx: LayerContext) => void;
  /** Double-click at the library root (leave the browser). */
  onLeave: (ctx: LayerContext) => void;
};

type BrowseLevel = {
  parentId: string;
  title: string;
  /** null while the listing is loading. */
  items: MediaBrowseItem[] | null;
  error: string;
  /** Holds the loaded items; keeps this level's selection and scroll while a child level is open. */
  menu: Menu<MediaBrowseItem>;
};

type BrowsePhase = "idle" | "connecting" | "ready" | "failed";

/**
 * Library browser over another app's MediaBrowserService (the Android Auto
 * mechanism): connecting starts the player's process if needed, so this works
 * with no media session active and the phone locked. Scroll to select, click
 * to open a folder or play an item, double-click to go up (leaving the browser
 * when already at the root).
 */
export class MediaBrowseLayer implements Layer {
  private phase: BrowsePhase = "idle";
  private connectError = "";
  private levels: BrowseLevel[] = [];
  private removed = false;

  constructor(private readonly options: MediaBrowseOptions) {}

  paint(ctx: LayerContext): GrayImage {
    if (this.phase === "idle") {
      this.startConnect(ctx);
    }
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);

    image.drawText(font, 20, 8, `Library: ${this.options.app.appName}`, 220);

    if (this.phase === "connecting" || this.phase === "idle") {
      image.drawText(font, 24, headerHeight(font) + 8, `Starting ${this.options.app.appName}...`, 150);
      image.drawText(font, 20, height - font.lineHeight - 4, `${GESTURE_DOUBLE_CLICK} back`, 110);
      return image;
    }
    if (this.phase === "failed") {
      image.drawText(font, 24, headerHeight(font) + 8, "Could not connect:", 180);
      image.drawText(font, 24, headerHeight(font) + 8 + lineStep(font), truncateRight(font, this.connectError, width - 48), 140);
      image.drawText(font, 20, height - font.lineHeight - 4, `${GESTURE_CLICK} retry   ${GESTURE_DOUBLE_CLICK} back`, 110);
      return image;
    }

    const level = this.currentLevel();
    const path = this.levels.map((entry) => entry.title).join(" / ");
    image.drawText(font, 20, 8 + lineStep(font), truncateLeft(font, path, width - 40), 130);

    if (!level || level.items === null) {
      image.drawText(font, 24, headerHeight(font) + 8, level?.error ? level.error : "Loading...", level?.error ? 140 : 150);
      image.drawText(font, 20, height - font.lineHeight - 4, `${GESTURE_DOUBLE_CLICK} up / back`, 110);
      return image;
    }

    const items = level.items;
    if (!items.length) {
      image.drawText(font, 24, headerHeight(font) + 8, "(empty)", 120);
      image.drawText(font, 20, height - font.lineHeight - 4, `${GESTURE_DOUBLE_CLICK} up / back`, 110);
      return image;
    }

    const listTop = headerHeight(font);
    const listHeight = height - listTop - font.lineHeight - 10;
    const visibleRows = Math.max(1, (listHeight / tightRowHeight(font)) | 0);
    // Row boxes start one pixel above the header's bottom edge.
    level.menu.paint(
      image,
      { x: LIST_X - LIST_HIGHLIGHT_PAD, y: listTop - 1, width: width - 2 * LIST_X + 2 * LIST_HIGHLIGHT_PAD, height: listHeight },
      ctx.stack.isFocused(),
    );
    level.menu.drawScrollbar(image, width - 12, listTop, visibleRows * tightRowHeight(font) - 4);

    image.drawText(
      font,
      20,
      height - 16,
      `${GESTURE_SCROLL} select   ${GESTURE_CLICK} open/play   ${GESTURE_DOUBLE_CLICK} up / back`,
      110,
    );
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (this.phase === "failed") {
      if (event.type === "click") {
        this.phase = "idle";
        this.connectError = "";
      } else if (event.type === "double-click") {
        this.leave(ctx);
      }
      return;
    }
    if (event.type === "double-click") {
      if (this.levels.length > 1) {
        this.levels.pop();
      } else {
        this.leave(ctx);
      }
      return;
    }
    const level = this.currentLevel();
    const items = level?.items;
    if (!level || !items || !items.length) return;
    switch (event.type) {
      case "scroll-up":
      case "scroll-down":
        await level.menu.handleInput(event);
        return;
      case "click": {
        const item = level.menu.selectedItem;
        if (!item) return;
        if (item.browsable && item.playable) {
          ctx.stack.push(
            new MenuLayer(truncateRight(getDefaultSmallFont(), item.title || "(untitled)", 230), [
              {
                label: "Play",
                onSelect: (menuCtx) => {
                  menuCtx.stack.pop();
                  this.play(menuCtx, item);
                },
              },
              {
                label: "Open",
                onSelect: (menuCtx) => {
                  menuCtx.stack.pop();
                  this.descendInto(menuCtx, item);
                },
              },
            ]),
          );
        } else if (item.browsable) {
          this.descendInto(ctx, item);
        } else if (item.playable) {
          this.play(ctx, item);
        }
        return;
      }
      default:
        return;
    }
  }

  onRemoved(): void {
    this.removed = true;
    mediaBrowserBridge.disconnect();
  }

  private currentLevel(): BrowseLevel | undefined {
    return this.levels[this.levels.length - 1];
  }

  private leave(ctx: LayerContext): void {
    this.options.onLeave(ctx);
  }

  private play(ctx: LayerContext, item: MediaBrowseItem): void {
    mediaBrowserBridge.playFromMediaId(item.mediaId);
    this.options.onPlayed(ctx);
  }

  private descendInto(ctx: LayerContext, item: MediaBrowseItem): void {
    const level = this.createLevel(item.mediaId, item.title || "(untitled)");
    this.levels.push(level);
    this.loadLevel(ctx, level);
  }

  private createLevel(parentId: string, title: string): BrowseLevel {
    return {
      parentId,
      title,
      items: null,
      error: "",
      menu: new Menu<MediaBrowseItem>({
        wrap: false,
        rowGap: 1,
        highlight: { radius: 4 },
        getHeight: () => tightRowHeight(getDefaultSmallFont()),
        draw: (args) => this.drawItem(args),
      }),
    };
  }

  private drawItem({ image, item, x, y, width, height, selected }: MenuDrawArgs<MediaBrowseItem>): void {
    const font = getDefaultSmallFont();
    const value = selected ? 255 : 200;
    const textWidth = width - 2 * LIST_HIGHLIGHT_PAD - 16;
    const textY = centeredTextY(font, y, height);
    const title = truncateRight(font, item.title || "(untitled)", textWidth);
    image.drawText(font, x + LIST_HIGHLIGHT_PAD, textY, title, value);
    if (item.subtitle) {
      const titleWidth = font.measureText(title);
      const subtitleWidth = font.measureText(item.subtitle);
      if (titleWidth + subtitleWidth + 24 <= textWidth) {
        image.drawText(font, x + LIST_HIGHLIGHT_PAD + textWidth - subtitleWidth, textY, item.subtitle, 110);
      }
    }
    if (item.browsable) {
      drawSubmenuIndicator(image, font, x, y, width, height, selected ? value : 110);
    }
  }

  private startConnect(ctx: LayerContext): void {
    this.phase = "connecting";
    mediaBrowserBridge
      .connect(this.options.app)
      .then((rootId) => {
        if (this.removed) return;
        this.phase = "ready";
        const root = this.createLevel(rootId, "Library");
        this.levels = [root];
        this.loadLevel(ctx, root);
        ctx.actions.requestRender();
      })
      .catch((error) => {
        if (this.removed) return;
        this.phase = "failed";
        this.connectError = error instanceof Error ? error.message : String(error);
        ctx.actions.requestRender();
      });
  }

  private loadLevel(ctx: LayerContext, level: BrowseLevel): void {
    mediaBrowserBridge
      .browse(level.parentId)
      .then((items) => {
        if (this.removed) return;
        level.items = items;
        level.menu.setItems(items, 0);
        ctx.actions.requestRender();
      })
      .catch((error) => {
        if (this.removed) return;
        level.error = error instanceof Error ? error.message : String(error);
        ctx.actions.requestRender();
      });
  }
}

function truncateRight(font: UiFont, text: string, maxWidth: number): string {
  if (font.measureText(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.measureText(`${out}...`) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function truncateLeft(font: UiFont, text: string, maxWidth: number): string {
  if (font.measureText(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.measureText(`...${out}`) > maxWidth) {
    out = out.slice(1);
  }
  return `...${out}`;
}
