import { clamp } from "~/util/numeric-util";
import { formatRelativeTime } from "~/util/date-util";
import { getDefaultSmallFont } from "../graphics/ui-fonts";
import { truncateText, wrapText } from "../graphics/textwrap";
import { GrayImage, type UiFont } from "../graphics/image";
import { LIST_ROW_TEXT_INSET, centeredTextY, lineStep, listRowHeight } from "./metrics";
import {
  ALL_NOTIFICATIONS,
  dismissNotification,
  invokeNotificationAction,
  readActiveNotifications,
  readNotificationCustomView,
  readNotificationIconByKey,
  readNotificationLargeIcon,
  readNotificationPicture,
  type AndroidNotification,
  type AndroidNotificationAction,
  type NotificationImageResult,
} from "../native/notification-icons";
import { setNotificationSourceEnabled } from "../native/notification-sources";
import { NOTIFICATION_ICON_SIZE } from "../native/notification-types";
import { notificationEmptyMessage } from "../native/notification-access";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../util/render-freshness";
import { type InputEvent } from "./gestures";
import { type Layer, type LayerContext, type PaintBelow } from "./layers";
import { Menu, type MenuBox } from "./menu-core";
import type { Viewport } from "./viewport";

// The list's title, as in the other list apps (terminal, calendar): this far
// in from the cards' left edge (in line with their icons) and below the
// window's top padding; the first card starts LIST_TOP_GAP under its top.
const TITLE_INSET_X = 10;
const TITLE_OFFSET_Y = 2;
const LIST_TOP_GAP = 28;
/** The empty-list message: indented from the title, and this far under its top. */
const EMPTY_MESSAGE_INDENT = 6;
const EMPTY_MESSAGE_GAP = 62;
const ICON_SIZE = NOTIFICATION_ICON_SIZE;
const ICON_TEXT_GAP = 8;
const CARD_TEXT_X = 10 + ICON_SIZE + ICON_TEXT_GAP;
const CARD_GAP = 6;
const MAX_NOTIFICATIONS = 50;
// Right-hand action menu of the detail view.
const DETAIL_MENU_WIDTH = 148;
/** Gap between the content column and the action menu's row boxes. */
const DETAIL_MENU_GAP = 12;
const DETAIL_MENU_ROW_GAP = 3;
/** Row text inset from the row box: horizontal, then vertical. */
const DETAIL_MENU_TEXT_X = 8;
const DETAIL_MENU_TEXT_Y = 4;
/** Gaps below the title's line box and below the icon/app-name header row. */
const DETAIL_HEADER_GAP = 3;
const DETAIL_BODY_GAP = 4;
/** Untitled text lines that attached images (custom layout, picture) leave room for above them, when there are that many; they take the rest. */
const DETAIL_PICTURE_TEXT_LINES = 2;
/** Gap between the text and an attached picture. */
const DETAIL_PICTURE_GAP = 6;
/** An attached picture with less height than this to fit in (a large UI font) is left out. */
const DETAIL_PICTURE_MIN_HEIGHT = 32;
/** Likewise a custom layout; Dexcom's reading is about 40 high. */
const DETAIL_CUSTOM_VIEW_MIN_HEIGHT = 16;
/** A large icon (sender's avatar, site's logo): at the right of a list card, left of the detail view's title. */
const LARGE_ICON_SIZE = 32;
const LARGE_ICON_GAP = 8;
// Disable-source confirmation: actions on top, the explanation below them.
const CONFIRM_TEXT_X = 10;
const CONFIRM_PROMPT_GAP = 16;

/** Icon for a paint pass: allow-stale, reporting staleness to the render loop. */
function iconForNotification(key: string): GrayImage | null {
  const { icon, stale } = readNotificationIconByKey(key, renderPassAllowsStaleData());
  if (stale) {
    noteStaleDataUsed();
  }
  return icon;
}

/** A notification image read for a paint pass (allow-stale like iconForNotification). */
function imageForPaint(
  read: (allowStale: boolean) => NotificationImageResult,
): NotificationImageResult {
  const result = read(renderPassAllowsStaleData());
  if (result.stale) {
    noteStaleDataUsed();
  }
  return result;
}

/** Attached picture for a paint pass, fitting maxWidth x maxHeight. */
function pictureForNotification(notification: AndroidNotification, maxWidth: number, maxHeight: number): GrayImage | null {
  if (!notification.hasPicture || maxHeight < DETAIL_PICTURE_MIN_HEIGHT) return null;
  return imageForPaint((allowStale) => readNotificationPicture(notification, maxWidth, maxHeight, allowStale)).image;
}

/** Large icon for a paint pass, LARGE_ICON_SIZE square at most. */
function largeIconForNotification(notification: AndroidNotification): GrayImage | null {
  if (!notification.hasLargeIcon) return null;
  return imageForPaint((allowStale) => readNotificationLargeIcon(notification, LARGE_ICON_SIZE, allowStale)).image;
}

type CardLayout = {
  notification: AndroidNotification;
  height: number;
  lines: string[];
};

type DetailMenuItem =
  | { kind: "back"; label: string }
  | { kind: "action"; label: string; action: AndroidNotificationAction }
  | { kind: "dismiss"; label: string }
  | { kind: "disable-source"; label: string };

type ConfirmationItem = { label: string; run: (ctx: LayerContext) => void };

export type SingleNotificationLayerOrigin = "notifications-list" | "new-notification-modal" | "notification-tray";

type SingleNotificationLayerOptions = {
  origin: SingleNotificationLayerOrigin;
  /**
   * Close hook for hosts that take the layer down themselves instead of
   * popping it: the modal (the layer is the modal stack's base, so pop()
   * cannot close it), and the app switcher's tray selection, which keeps
   * the layer up until the selection moves on. `gone` says the notification
   * itself went away (dismissed, or removed by one of its actions).
   */
  onClose?: (ctx: LayerContext, gone: boolean) => void;
};

/**
 * Scrollable list of active Android notifications. Sized to its hosting
 * stack (the Notifications app viewport). Selecting one pushes the detail
 * view.
 */
export class NotificationsListLayer implements Layer {
  private selectedKey = "";

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height, padding } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    // Cards span the window between the padding suggested for its sides.
    const cardX = padding.left;
    const cardWidth = width - padding.left - padding.right;
    const cardTextWidth = cardWidth - CARD_TEXT_X - 14;
    const titleX = cardX + TITLE_INSET_X;
    const titleY = padding.top + TITLE_OFFSET_Y;
    const notifications = readActiveNotifications(MAX_NOTIFICATIONS);
    const selectedIndex = this.resolveSelectedIndex(notifications);
    const layouts = notifications.map((notification, index) =>
      buildNotificationCardLayout(font, notification, index === selectedIndex, cardTextWidth),
    );

    if (!notifications.length) {
      image.drawText(font, titleX, titleY, "Notifications", 220);
      const message = notificationEmptyMessage();
      const messageX = titleX + EMPTY_MESSAGE_INDENT;
      const messageLines = wrapText(font, message, width - padding.right - messageX);
      for (let index = 0; index < messageLines.length; index++) {
        image.drawText(font, messageX, titleY + EMPTY_MESSAGE_GAP + index * lineStep(font), messageLines[index]!, 190);
      }
      return image;
    }

    const focused = ctx.stack.isFocused();
    // The whole window scrolls, title and all, so cards scrolled past either
    // end are cut off at the window's own edges; the padding suggested for
    // the top and bottom edges lies inside the scrolled content, above the
    // title and below the last card.
    const listTop = titleY + LIST_TOP_GAP;
    const scrollY = scrollForSelected(layouts, selectedIndex, height - listTop, padding.bottom);
    // Card text is drawn as deferred glyphs (always composited above raster
    // fills), so a fixed title would show through cards scrolled over it;
    // moving it with the content keeps it above the first card instead.
    if (titleY - scrollY + font.lineHeight > 0) {
      image.drawText(font, titleX, titleY - scrollY, "Notifications", 220);
    }
    let cursorY = listTop - scrollY;
    for (let index = 0; index < layouts.length; index++) {
      const layout = layouts[index]!;
      if (cursorY + layout.height > 0 && cursorY < height) {
        // Icons are only resolved for cards actually drawn, so a long list
        // does not fetch icons for everything below the fold.
        const icon = iconForNotification(layout.notification.key);
        const largeIcon = largeIconForNotification(layout.notification);
        drawNotificationCard(image, font, layout, cardX, cursorY, cardWidth, index === selectedIndex, focused, icon, largeIcon);
      }
      cursorY += layout.height + CARD_GAP;
      if (cursorY > height + 80) break;
    }

    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    const notifications = readActiveNotifications(MAX_NOTIFICATIONS);
    const selectedIndex = this.resolveSelectedIndex(notifications);
    if (event.type === "double-click") {
      // At the app's root this is intercepted by the yield wrapper; reached
      // only if hosted somewhere deeper, where popping is right.
      ctx.stack.pop();
      return;
    }
    if (!notifications.length) return;

    if (event.type === "scroll-up") {
      this.selectedKey = notifications[Math.max(0, selectedIndex - 1)]!.key;
      return;
    }
    if (event.type === "scroll-down") {
      this.selectedKey = notifications[Math.min(notifications.length - 1, selectedIndex + 1)]!.key;
      return;
    }
    if (event.type === "click") {
      ctx.stack.push(new SingleNotificationLayer(notifications[selectedIndex]!.key, {
        origin: "notifications-list",
      }));
    }
  }

  private resolveSelectedIndex(notifications: AndroidNotification[]): number {
    if (!notifications.length) {
      this.selectedKey = "";
      return -1;
    }
    let index = notifications.findIndex((notification) => notification.key === this.selectedKey);
    if (index < 0) {
      index = 0;
      this.selectedKey = notifications[0]!.key;
    }
    return index;
  }
}

/**
 * One notification's full content plus its action menu. Sized to its hosting
 * stack: the Notifications app viewport, or the interior of the shell's
 * new-notification modal.
 */
export class SingleNotificationLayer implements Layer {
  /** The action column; its items are rebuilt from the live notification on every paint and input. */
  private readonly detailMenu = createNotificationActionMenu<DetailMenuItem>((item) => item.kind === "disable-source");
  private confirmation: { source: AndroidNotification; menu: Menu<ConfirmationItem> } | null = null;
  // The last paint, which a tray-hosted layer repeats once its notification
  // is gone, until the tray swaps in a neighbour's (see closeUnavailableNotification).
  private lastImage: GrayImage | null = null;

  constructor(
    private readonly notificationKey: string,
    private readonly options: SingleNotificationLayerOptions,
  ) {}

  /** Whether the layer stays up once its notification is gone: the disable-source confirmation dismisses it first. */
  outlivesNotification(): boolean {
    return this.confirmation !== null;
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    if (this.confirmation) return this.paintConfirmation(ctx);
    const font = getDefaultSmallFont();
    const viewport = ctx.stack.getBaseSize();
    const image = new GrayImage(viewport.width, viewport.height, 0);
    const notification = readActiveNotifications(ALL_NOTIFICATIONS).find((item) => item.key === this.notificationKey);

    if (!notification) {
      return this.closeUnavailableNotification(ctx, paintBelow);
    }

    this.detailMenu.setItems(buildDetailMenu(notification, this.options.origin));
    const layout = notificationDetailLayout(viewport);
    drawDetailContent(image, font, notification, iconForNotification(notification.key), layout);
    this.detailMenu.paint(image, layout.menuBox, ctx.stack.isFocused());
    this.lastImage = image;
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (this.confirmation) {
      const { menu } = this.confirmation;
      if (event.type === "double-click") this.close(ctx);
      else if (event.type === "click") menu.selectedItem?.run(ctx);
      else await menu.handleInput(event);
      return;
    }
    const notification = readActiveNotifications(ALL_NOTIFICATIONS).find((item) => item.key === this.notificationKey);
    if (!notification) {
      this.closeUnavailableNotification(ctx);
      return;
    }
    this.detailMenu.setItems(buildDetailMenu(notification, this.options.origin));

    if (event.type === "double-click") {
      this.close(ctx);
      return;
    }
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      await this.detailMenu.handleInput(event);
      return;
    }
    if (event.type !== "click") return;

    // "(unavailable)" actions stay clickable: Android decides whether they do anything.
    const item = this.detailMenu.selectedItem;
    if (!item) return;
    if (item.kind === "back") {
      this.close(ctx);
    } else if (item.kind === "action") {
      invokeNotificationAction(this.notificationKey, item.action.index);
      if (!readActiveNotifications(ALL_NOTIFICATIONS).some((active) => active.key === this.notificationKey)) {
        this.closeUnavailableNotification(ctx);
      }
    } else if (item.kind === "dismiss") {
      dismissNotification(this.notificationKey);
      this.closeUnavailableNotification(ctx);
    } else if (item.kind === "disable-source") {
      // Keep the modal alive for confirmation even after Android removes the notification.
      this.confirmation = {
        source: notification,
        menu: new Menu<ConfirmationItem>({
          items: [
            { label: "Cancel", run: (runCtx) => this.close(runCtx) },
            { label: "Turn off popups", run: (runCtx) => {
              setNotificationSourceEnabled(notification, false);
              this.close(runCtx);
            } },
          ],
          wrap: true,
          rowGap: 1,
          getHeight: () => listRowHeight(getDefaultSmallFont()),
          draw: ({ image, item: option, x, y, selected }) => {
            image.drawText(getDefaultSmallFont(), x + CONFIRM_TEXT_X, y + LIST_ROW_TEXT_INSET, option.label, selected ? 255 : 200);
          },
        }),
      };
      dismissNotification(this.notificationKey);
    }
  }

  private paintConfirmation(ctx: LayerContext): GrayImage {
    const { source, menu } = this.confirmation!;
    const font = getDefaultSmallFont();
    const { width, height, padding } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const contentWidth = width - padding.left - padding.right;
    // Put actions first so they remain reachable even with a large UI font.
    const menuBox: MenuBox = {
      x: padding.left,
      y: padding.top,
      width: contentWidth,
      height: Math.min(menu.items.length * listRowHeight(font), height - padding.top),
    };
    menu.paint(image, menuBox, ctx.stack.isFocused());
    const top = menuBox.y + menuBox.height + CONFIRM_PROMPT_GAP;
    const prompt = `Turn off notification popups from ${source.appName || source.packageName}? You can turn them back on in the Notifications app's Notification filter.`;
    // In line with the actions' labels.
    const promptX = menuBox.x + CONFIRM_TEXT_X;
    const promptWidth = contentWidth - 2 * CONFIRM_TEXT_X;
    const lines = wrapText(font, prompt, promptWidth);
    const maxLines = Math.max(1, Math.floor((height - padding.bottom - top) / lineStep(font)));
    for (let index = 0; index < Math.min(lines.length, maxLines); index++) {
      const text = index === maxLines - 1 && lines.length > maxLines
        ? truncateText(font, lines[index] + "...", promptWidth) : lines[index]!;
      image.drawText(font, promptX, top + index * lineStep(font), text, 210);
    }
    return image;
  }

  /** Leave the detail view, whatever hosts it. */
  private close(ctx: LayerContext, gone = false): void {
    if (this.options.onClose) {
      this.options.onClose(ctx, gone);
    } else {
      ctx.stack.pop();
    }
  }

  private closeUnavailableNotification(ctx: LayerContext, paintBelow?: PaintBelow): GrayImage {
    this.close(ctx, true);
    const { width, height } = ctx.stack.getBaseSize();
    // The tray replaces this layer only after the paint (swapping layers
    // mid-paint would render re-entrantly); meanwhile the screen keeps what
    // it showed rather than flashing the list beneath.
    if (this.options.origin === "notification-tray" && this.lastImage) {
      return this.lastImage.clone();
    }
    return paintBelow ? paintBelow() : new GrayImage(width, height, 0);
  }
}


function buildNotificationCardLayout(
  font: UiFont,
  notification: AndroidNotification,
  selected: boolean,
  fullTextWidth: number,
): CardLayout {
  // The large icon sits at the card's right, beside all its text.
  const cardTextWidth = notification.hasLargeIcon ? fullTextWidth - LARGE_ICON_SIZE - LARGE_ICON_GAP : fullTextWidth;
  const lines: string[] = [];
  const time = formatRelativeTime(notification.postTime);
  const title = notificationTitle(notification);
  const timeSuffix = time ? `  ${time}` : "";
  lines.push(truncateText(font, `${title}${timeSuffix}`, cardTextWidth));

  const appName = notification.appName || notification.packageName;
  const body = primaryNotificationBody(notification);

  if (selected) {
    if (appName && appName !== title) {
      lines.push(truncateText(font, appName, cardTextWidth));
    }
    if (body) {
      lines.push(...wrapText(font, body, cardTextWidth).slice(0, 4));
    }
  } else if (body) {
    lines.push(truncateText(font, wrapText(font, body, cardTextWidth)[0]!, cardTextWidth));
  }
  if (notification.actions.length) {
    lines.push(`${notification.actions.length} quick action${notification.actions.length === 1 ? "" : "s"}`);
  }
  return {
    notification,
    lines,
    height: Math.max(ICON_SIZE + 18, notification.hasLargeIcon ? LARGE_ICON_SIZE + 16 : 0, 12 + lines.length * lineStep(font)),
  };
}

function drawNotificationCard(
  image: GrayImage,
  font: UiFont,
  layout: CardLayout,
  x: number,
  y: number,
  width: number,
  selected: boolean,
  focused: boolean,
  icon: GrayImage | null,
  largeIcon: GrayImage | null,
): void {
  // Match the shared menu highlight: faint border + black fill when
  // unselected; bright border when selected; the non-black fill only appears
  // when the app also has focus (selected-but-unfocused stays black-filled).
  const fill = selected && focused ? 15 : 1;
  const stroke = selected ? 110 : 38;
  image.fillRoundedRect(x, y, width, layout.height, fill, 8);
  image.drawRoundedRect(x, y, width, layout.height, stroke, 8);
  if (icon) {
    image.bitBlt(icon, x + 10, y + 8, { transparentZero: true });
  }
  if (largeIcon) {
    image.bitBlt(largeIcon, x + width - 10 - LARGE_ICON_SIZE + ((LARGE_ICON_SIZE - largeIcon.width) >> 1), y + 8);
  }
  for (let index = 0; index < layout.lines.length; index++) {
    const value = index === 0 ? 140 : selected ? 235 : 185;
    image.drawText(font, x + CARD_TEXT_X, y + 7 + index * lineStep(font), layout.lines[index]!, value);
  }
}

/**
 * How far the list is scrolled to centre the selected card in the rows from
 * the first card's resting top to the window's bottom (`viewportHeight` of
 * them), without scrolling past the last card and the `bottomPadding` kept
 * under it.
 */
function scrollForSelected(layouts: CardLayout[], selectedIndex: number, viewportHeight: number, bottomPadding: number): number {
  if (selectedIndex < 0) return 0;
  let selectedTop = 0;
  for (let index = 0; index < selectedIndex; index++) {
    selectedTop += layouts[index]!.height + CARD_GAP;
  }
  const selectedBottom = selectedTop + layouts[selectedIndex]!.height;
  const contentHeight = layouts.reduce((sum, layout) => sum + layout.height + CARD_GAP, -CARD_GAP) + bottomPadding;
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const centered = selectedTop - Math.max(0, (viewportHeight - (selectedBottom - selectedTop)) / 2);
  return clamp(centered | 0, 0, maxScroll);
}

function drawDetailContent(
  image: GrayImage,
  font: UiFont,
  notification: AndroidNotification,
  icon: GrayImage | null,
  layout: NotificationDetailLayout,
): void {
  const { contentX, contentWidth, bottom } = layout;
  const step = lineStep(font);
  let top = drawNotificationHeader(image, font, icon,
    `${notification.appName || notification.packageName}  ${formatRelativeTime(notification.postTime)}`, layout);

  // The title, beside the large icon (a sender's avatar, a site's logo) when
  // there is one. A picture or custom layout can be the whole notification
  // (Dexcom's has no text), so either stands in for the "(untitled)" placeholder.
  const hasImages = Boolean(notification.hasPicture || notification.hasCustomView);
  const title = notification.title || (hasImages ? "" : "(untitled)");
  const avatarSize = notification.hasLargeIcon ? LARGE_ICON_SIZE : 0;
  const titleX = avatarSize ? contentX + avatarSize + LARGE_ICON_GAP : contentX;
  const titleWidth = contentX + contentWidth - titleX;
  const titleLines = title ? wrapText(font, title, titleWidth) : [];
  let titleHeight = 0;
  if (avatarSize) {
    const avatar = largeIconForNotification(notification);
    if (avatar) image.bitBlt(avatar, contentX + ((avatarSize - avatar.width) >> 1), top + ((avatarSize - avatar.height) >> 1));
    titleHeight = avatarSize;
  }
  if (titleLines.length) {
    // A title shorter than the avatar is centered on it.
    const titleTop = top + Math.max(0, (avatarSize - titleLines.length * step) >> 1);
    const shown = drawClippedLines(image, font, titleLines, titleX, titleTop, titleWidth, ((bottom - top) / step) | 0, 230);
    titleHeight = Math.max(titleHeight, shown * step);
  }

  const lines: string[] = [];
  const body = detailNotificationBody(notification);
  if (body) {
    lines.push(...wrapText(font, body, contentWidth));
  }
  const meta = [notification.subText, notification.infoText, notification.summaryText].filter(Boolean).join("  ");
  if (meta) {
    if (lines.length) lines.push("");
    lines.push(...wrapText(font, meta, contentWidth));
  }
  // Text follows the title after a blank line (just a gap beside an avatar); images after a gap.
  if (titleHeight) {
    top += titleHeight + (lines.length && !avatarSize ? step : DETAIL_PICTURE_GAP);
  }

  // The custom layout, then the picture, take what is left below the title,
  // or below the first few lines of text when there is no title.
  const reservedTextHeight = titleHeight ? 0 : Math.min(lines.length, DETAIL_PICTURE_TEXT_LINES) * step;
  const roomForImages = bottom - top - (reservedTextHeight ? reservedTextHeight + DETAIL_PICTURE_GAP : 0);
  let customView: GrayImage | null = null;
  if (notification.hasCustomView && roomForImages >= DETAIL_CUSTOM_VIEW_MIN_HEIGHT) {
    const result = imageForPaint((allowStale) => readNotificationCustomView(notification, contentWidth, roomForImages, allowStale));
    customView = result.image;
    if (!customView && !result.stale && notification.customText?.length) {
      // It couldn't be drawn: its text is better than nothing.
      lines.unshift(...wrapText(font, notification.customText.join(" "), contentWidth), ...(lines.length ? [""] : []));
    }
  }
  const picture = pictureForNotification(notification, contentWidth,
    roomForImages - (customView ? customView.height + DETAIL_PICTURE_GAP : 0));

  // The text gets whatever the images leave, above them, with its last shown
  // line marked when some is cut off.
  const imagesHeight = (customView ? customView.height : 0) + (picture ? picture.height : 0)
    + (customView && picture ? DETAIL_PICTURE_GAP : 0);
  const roomForText = bottom - top - (imagesHeight ? imagesHeight + DETAIL_PICTURE_GAP : 0);
  const shownLines = drawClippedLines(image, font, lines, contentX, top, contentWidth, (roomForText / step) | 0, 190);
  let imageTop = top + shownLines * step + (shownLines ? DETAIL_PICTURE_GAP : 0);
  if (customView) {
    image.bitBlt(customView, contentX, imageTop);
    imageTop += customView.height + DETAIL_PICTURE_GAP;
  }
  if (picture) {
    image.bitBlt(picture, contentX, imageTop);
  }
}

/**
 * Draw up to maxLines of lines from (x, y), marking the last one drawn with
 * "..." when some are left out. Returns how many were drawn.
 */
function drawClippedLines(
  image: GrayImage,
  font: UiFont,
  lines: string[],
  x: number,
  y: number,
  width: number,
  maxLines: number,
  value: number,
): number {
  const shown = Math.min(lines.length, Math.max(0, maxLines));
  for (let index = 0; index < shown; index++) {
    const line = index === shown - 1 && lines.length > shown ? truncateText(font, lines[index] + "...", width) : lines[index]!;
    image.drawText(font, x, y + index * lineStep(font), line, value);
  }
  return shown;
}

/**
 * Where a notification detail view's parts go in its viewport: a content
 * column from the padding suggested for the left edge, and an action column
 * of DETAIL_MENU_WIDTH ending at the right edge's. The content keeps inside
 * the top and bottom padding (`top`, `bottom`). The action menu scrolls, so
 * its box runs to the top and bottom edges with their padding inside it.
 */
export type NotificationDetailLayout = {
  contentX: number;
  contentWidth: number;
  top: number;
  bottom: number;
  menuBox: MenuBox;
};

export function notificationDetailLayout(viewport: Viewport): NotificationDetailLayout {
  const { width, height, padding } = viewport;
  const menuX = width - padding.right - DETAIL_MENU_WIDTH;
  return {
    contentX: padding.left,
    contentWidth: menuX - DETAIL_MENU_GAP - padding.left,
    top: padding.top,
    bottom: height - padding.bottom,
    menuBox: { x: menuX, y: 0, width: DETAIL_MENU_WIDTH, height, padTop: padding.top, padBottom: padding.bottom },
  };
}

/**
 * The top of a notification detail view: the "Notification" title, then the
 * source's icon and label. Returns the y where the body starts.
 */
export function drawNotificationHeader(image: GrayImage, font: UiFont, icon: GrayImage | null, sourceLabel: string,
    layout: NotificationDetailLayout): number {
  const { contentX, top } = layout;
  image.drawText(font, contentX, top, "Notification", 220);
  // The header row (icon + app name) and the body stack below the title's
  // line box, so a large UI font pushes them down instead of overlapping.
  const headerTop = top + font.lineHeight + DETAIL_HEADER_GAP;
  const headerHeight = Math.max(ICON_SIZE, font.lineHeight);
  let sourceX = contentX;
  if (icon) {
    image.bitBlt(icon, contentX, headerTop + ((headerHeight - ICON_SIZE) >> 1), { transparentZero: true });
    sourceX = contentX + ICON_SIZE + ICON_TEXT_GAP;
  }
  image.drawText(font, sourceX, centeredTextY(font, headerTop, headerHeight), sourceLabel, 150);
  return headerTop + headerHeight + DETAIL_BODY_GAP;
}

/**
 * A notification detail view's right-hand action column. Rows truncate their
 * label to one line, except those `wraps` picks, which wrap it.
 */
export function createNotificationActionMenu<T extends { label: string }>(wraps: (item: T) => boolean = () => false): Menu<T> {
  const rowLines = (font: UiFont, item: T, rowWidth: number): string[] => {
    const textWidth = rowWidth - 2 * DETAIL_MENU_TEXT_X;
    return wraps(item) ? wrapText(font, item.label, textWidth) : [truncateText(font, item.label, textWidth)];
  };
  return new Menu<T>({
    wrap: false,
    rowGap: DETAIL_MENU_ROW_GAP,
    highlight: { radius: 6 },
    getHeight: (item, width) => {
      const font = getDefaultSmallFont();
      return rowLines(font, item, width).length * lineStep(font) + 8;
    },
    draw: ({ image, item, x, y, width, selected }) => {
      const font = getDefaultSmallFont();
      const lines = rowLines(font, item, width);
      for (let line = 0; line < lines.length; line++) {
        image.drawText(font, x + DETAIL_MENU_TEXT_X, y + DETAIL_MENU_TEXT_Y + line * lineStep(font), lines[line]!, selected ? 255 : 185);
      }
    },
  });
}

function buildDetailMenu(notification: AndroidNotification, origin: SingleNotificationLayerOrigin): DetailMenuItem[] {
  return [
    { kind: "back", label: "Back" },
    ...notification.actions.map((action): DetailMenuItem => ({
      kind: "action",
      label: action.enabled ? action.title : `${action.title} (unavailable)`,
      action,
    })),
    { kind: "dismiss", label: notification.dismissLabel || "Dismiss" },
    ...(origin === "new-notification-modal" && notification.packageName
      ? [{ kind: "disable-source" as const, label: "Don't show on glasses again" }] : []),
  ];
}

function primaryNotificationBody(notification: AndroidNotification): string {
  const title = notificationTitle(notification);
  const body = notification.bigText || notification.text || notification.lines.join(" / ") || notification.summaryText || "";
  return body === title ? "" : body;
}

function detailNotificationBody(notification: AndroidNotification): string {
  const lines = notification.lines.length ? notification.lines.join("\n") : "";
  return [notification.bigText || notification.text, lines].filter(Boolean).join("\n");
}

function notificationTitle(notification: AndroidNotification): string {
  return notification.title || notification.text || notification.customText?.join(" ") || notification.summaryText
    || notification.appName || notification.packageName || "(untitled)";
}
