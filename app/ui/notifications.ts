import { clamp } from "~/util/numeric-util";
import { formatRelativeTime } from "~/util/date-util";
import { getDefaultSmallFont } from "../graphics/ui-fonts";
import { truncateText } from "../graphics/textwrap";
import { GrayImage, type UiFont } from "../graphics/image";
import { wrapText } from "../graphics/textwrap";
import { lineStep, listRowHeight } from "./metrics";
import {
  dismissNotification,
  invokeNotificationAction,
  readActiveNotifications,
  readNotificationIconByKey,
  type AndroidNotification,
  type AndroidNotificationAction,
} from "../native/notification-icons";
import { isNotificationListenerEnabled } from "../native/notification-access";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../util/render-freshness";
import { type InputEvent } from "./gestures";
import { type Layer, type LayerContext, type PaintBelow } from "./layers";

const PAGE_X = 12;
const PAGE_Y = 12;
// Title position, shared with the other list apps (terminal, calendar).
const TITLE_X = 18;
const TITLE_Y = 10;
const LIST_TOP = 38;
const CARD_X = 20;
const ICON_SIZE = 24;
const ICON_TEXT_GAP = 8;
const CARD_TEXT_X = 10 + ICON_SIZE + ICON_TEXT_GAP;
const CARD_GAP = 6;
const MAX_NOTIFICATIONS = 50;
// Right-hand action menu of the detail view.
const DETAIL_MENU_WIDTH = 148;
const DETAIL_CONTENT_X = 24;

/** Icon for a paint pass: allow-stale, reporting staleness to the render loop. */
function iconForNotification(key: string): GrayImage | null {
  const { icon, stale } = readNotificationIconByKey(key, renderPassAllowsStaleData());
  if (stale) {
    noteStaleDataUsed();
  }
  return icon;
}

type CardLayout = {
  notification: AndroidNotification;
  height: number;
  lines: string[];
};

type DetailMenuItem =
  | { kind: "back"; label: string }
  | { kind: "action"; label: string; action: AndroidNotificationAction }
  | { kind: "dismiss"; label: string };

export type SingleNotificationLayerOrigin = "notifications-list" | "new-notification-modal";

type SingleNotificationLayerOptions = {
  origin: SingleNotificationLayerOrigin;
  /** Close hook for the modal origin (the layer is the modal stack's base, so pop() cannot close it). */
  closeModal?: (ctx: LayerContext) => void;
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
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const cardWidth = width - 2 * CARD_X;
    const cardTextWidth = cardWidth - CARD_TEXT_X - 14;
    const notifications = readActiveNotifications(MAX_NOTIFICATIONS);
    const selectedIndex = this.resolveSelectedIndex(notifications);
    const layouts = notifications.map((notification, index) =>
      buildNotificationCardLayout(font, notification, index === selectedIndex, cardTextWidth),
    );

    if (!notifications.length) {
      image.drawText(font, TITLE_X, TITLE_Y, "Notifications", 220);
      const message = isNotificationListenerEnabled()
        ? "No current Android notifications."
        : "Grant permission on your phone to view notifications on the glasses.";
      const messageLines = wrapText(font, message, width - 48);
      for (let index = 0; index < messageLines.length; index++) {
        image.drawText(font, 24, 72 + index * lineStep(font), messageLines[index]!, 190);
      }
      return image;
    }

    const focused = ctx.stack.isFocused();
    const listBottom = height;
    const scrollY = scrollForSelected(layouts, selectedIndex, listBottom - LIST_TOP);
    // The title scrolls away with the list. Card text is drawn as deferred
    // glyphs (always composited above raster fills), so a fixed title would
    // show through cards scrolled over it; moving it with the content keeps
    // it above the first card instead.
    if (TITLE_Y - scrollY + font.lineHeight > 0) {
      image.drawText(font, TITLE_X, TITLE_Y - scrollY, "Notifications", 220);
    }
    let cursorY = LIST_TOP - scrollY;
    for (let index = 0; index < layouts.length; index++) {
      const layout = layouts[index]!;
      if (cursorY + layout.height >= LIST_TOP && cursorY <= listBottom) {
        // Icons are only resolved for cards actually drawn, so a long list
        // does not fetch icons for everything below the fold.
        const icon = iconForNotification(layout.notification.key);
        drawNotificationCard(image, font, layout, CARD_X, cursorY, cardWidth, index === selectedIndex, focused, icon);
      }
      cursorY += layout.height + CARD_GAP;
      if (cursorY > listBottom + 80) break;
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
  private selectedMenuIndex = 0;

  constructor(
    private readonly notificationKey: string,
    private readonly options: SingleNotificationLayerOptions,
  ) {}

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const notification = readActiveNotifications(MAX_NOTIFICATIONS).find((item) => item.key === this.notificationKey);

    if (!notification) {
      return this.closeUnavailableNotification(ctx, paintBelow);
    }

    const menu = buildDetailMenu(notification);
    this.selectedMenuIndex = clamp(this.selectedMenuIndex, 0, Math.max(0, menu.length - 1));
    drawDetailContent(image, font, notification, iconForNotification(notification.key), width, height);
    drawDetailMenu(image, font, menu, this.selectedMenuIndex, width);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    const notification = readActiveNotifications(MAX_NOTIFICATIONS).find((item) => item.key === this.notificationKey);
    if (!notification) {
      this.closeUnavailableNotification(ctx);
      return;
    }
    const menu = buildDetailMenu(notification);

    if (event.type === "double-click") {
      this.close(ctx);
      return;
    }
    if (event.type === "scroll-up") {
      this.selectedMenuIndex = Math.max(0, this.selectedMenuIndex - 1);
      return;
    }
    if (event.type === "scroll-down") {
      this.selectedMenuIndex = Math.min(menu.length - 1, this.selectedMenuIndex + 1);
      return;
    }
    if (event.type !== "click") return;

    const item = menu[this.selectedMenuIndex]!;
    if (item.kind === "back") {
      this.close(ctx);
    } else if (item.kind === "action") {
      invokeNotificationAction(this.notificationKey, item.action.index);
      if (!readActiveNotifications(MAX_NOTIFICATIONS).some((item) => item.key === this.notificationKey)) {
        this.closeUnavailableNotification(ctx);
      }
    } else if (item.kind === "dismiss") {
      dismissNotification(this.notificationKey);
      this.closeUnavailableNotification(ctx);
    }
  }

  /** Leave the detail view, whatever hosts it. */
  private close(ctx: LayerContext): void {
    if (this.options.origin === "new-notification-modal") {
      this.options.closeModal?.(ctx);
    } else {
      ctx.stack.pop();
    }
  }

  private closeUnavailableNotification(ctx: LayerContext, paintBelow?: PaintBelow): GrayImage {
    this.close(ctx);
    const { width, height } = ctx.stack.getBaseSize();
    return paintBelow ? paintBelow() : new GrayImage(width, height, 0);
  }
}


function buildNotificationCardLayout(
  font: UiFont,
  notification: AndroidNotification,
  selected: boolean,
  cardTextWidth: number,
): CardLayout {
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
    height: Math.max(ICON_SIZE + 18, 12 + lines.length * lineStep(font)),
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
  for (let index = 0; index < layout.lines.length; index++) {
    const value = index === 0 ? 140 : selected ? 235 : 185;
    image.drawText(font, x + CARD_TEXT_X, y + 7 + index * lineStep(font), layout.lines[index]!, value);
  }
}

function scrollForSelected(layouts: CardLayout[], selectedIndex: number, viewportHeight: number): number {
  if (selectedIndex < 0) return 0;
  let selectedTop = 0;
  for (let index = 0; index < selectedIndex; index++) {
    selectedTop += layouts[index]!.height + CARD_GAP;
  }
  const selectedBottom = selectedTop + layouts[selectedIndex]!.height;
  const contentHeight = layouts.reduce((sum, layout) => sum + layout.height + CARD_GAP, 0);
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const centered = selectedTop - Math.max(0, (viewportHeight - (selectedBottom - selectedTop)) / 2);
  return clamp(centered | 0, 0, maxScroll);
}

function drawDetailContent(
  image: GrayImage,
  font: UiFont,
  notification: AndroidNotification,
  icon: GrayImage | null,
  width: number,
  height: number,
): void {
  const contentX = DETAIL_CONTENT_X;
  const menuX = width - DETAIL_MENU_WIDTH - 24;
  const contentWidth = menuX - contentX - 20;
  image.drawText(font, PAGE_X + 12, PAGE_Y + 9, "Notification", 220);
  let appLineX = contentX;
  if (icon) {
    image.bitBlt(icon, contentX, 36, { transparentZero: true });
    appLineX = contentX + ICON_SIZE + ICON_TEXT_GAP;
  }
  image.drawText(font, appLineX, 42, `${notification.appName || notification.packageName}  ${formatRelativeTime(notification.postTime)}`, 150);

  const lines: string[] = [];
  lines.push(...wrapText(font, notification.title || "(untitled)", contentWidth));
  const body = detailNotificationBody(notification);
  if (body) {
    lines.push("");
    lines.push(...wrapText(font, body, contentWidth));
  }
  const meta = [notification.subText, notification.infoText, notification.summaryText].filter(Boolean).join("  ");
  if (meta) {
    lines.push("");
    lines.push(...wrapText(font, meta, contentWidth));
  }

  const step = lineStep(font);
  const bodyTop = 48 + font.lineHeight + 4;
  const maxLines = Math.max(1, ((height - bodyTop - step) / step) | 0);
  for (let index = 0; index < Math.min(lines.length, maxLines); index++) {
    const line = lines[index]!;
    image.drawText(font, contentX, bodyTop + index * step, line, index === 0 ? 230 : 190);
  }
  if (lines.length > maxLines) {
    image.drawText(font, contentX, height - 24, "...", 140);
  }
}

function drawDetailMenu(image: GrayImage, font: UiFont, menu: DetailMenuItem[], selectedIndex: number, width: number): void {
  const menuX = width - DETAIL_MENU_WIDTH - 24;
  const menuY = 24;
  const rowH = listRowHeight(font);
  for (let index = 0; index < menu.length; index++) {
    const y = menuY + index * (rowH + 2);
    const selected = index === selectedIndex;
    if (selected) {
      image.fillRoundedRect(menuX - 8, y - 2, DETAIL_MENU_WIDTH, rowH - 1, 18, 6);
      image.drawRoundedRect(menuX - 8, y - 2, DETAIL_MENU_WIDTH, rowH - 1, 60, 6);
    }
    const label = truncateText(font, menu[index]!.label, DETAIL_MENU_WIDTH - 12);
    image.drawText(font, menuX, y + 2, label, selected ? 255 : 185);
  }
}

function buildDetailMenu(notification: AndroidNotification): DetailMenuItem[] {
  return [
    { kind: "back", label: "Back" },
    ...notification.actions.map((action): DetailMenuItem => ({
      kind: "action",
      label: action.enabled ? action.title : `${action.title} (unavailable)`,
      action,
    })),
    { kind: "dismiss", label: "Dismiss" },
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
  return notification.title || notification.text || notification.summaryText || notification.appName || notification.packageName || "(untitled)";
}
