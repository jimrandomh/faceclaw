import { BATTERY_ICON_WIDTH, drawBattery } from "../../../graphics/battery";
import { type GrayImage, type UiFont } from "../../../graphics/image";
import { getDefaultLargeFont, getDefaultMediumFont, getDefaultSmallFont } from "../../../graphics/ui-fonts";
import { onAndroidNotificationPosted, readActiveNotificationIcons } from "../../../native/notification-icons";
import { readPhoneBatteryState } from "../../../native/phone-battery";
import { formatClockDate, formatClockTime } from "../../../ui/clock-format";
import {
  batteryDisplayModeSetting,
  batteryIndicatorVisible,
  glassesBatteryVisibilitySetting,
  onAnySettingChanged,
  phoneBatteryVisibilitySetting,
  ringBatteryVisibilitySetting,
  type BatteryIndicatorVisibility,
} from "../../../ui/dashboard-settings";
import { shell } from "../../../ui/shell/shell";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../../../util/render-freshness";
import { type GlanceWidget } from "../widget";

const PAD = 8;
const NOTIFICATION_ICON_SIZE = 24;
const NOTIFICATION_ICON_GAP = 4;
const BATTERY_ITEM_GAP = 12;
const BATTERY_LABEL_VALUE = 150;

type BatteryItem = { label: string; percent: number; charging: boolean };

/**
 * Date and time, the phone's notification icons, and the phone/G2/R1
 * battery indicators: the top bar's contents, laid out for a card. Battery
 * style and per-device visibility follow Settings > Display > Battery
 * indicators, so the card agrees with the bar.
 */
export class SystemCardWidget implements GlanceWidget {
  private requestRender: (() => void) | null = null;
  private minuteTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeNotifications: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;

  start(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.scheduleMinuteTick();
    this.unsubscribeNotifications = onAndroidNotificationPosted(() => this.requestRender?.());
    this.unsubscribeSettings = onAnySettingChanged(() => this.requestRender?.());
  }

  stop(): void {
    this.requestRender = null;
    if (this.minuteTimer !== null) clearTimeout(this.minuteTimer);
    this.minuteTimer = null;
    this.unsubscribeNotifications?.();
    this.unsubscribeNotifications = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
  }

  /** Repaint on the minute boundary, so the clock never shows a stale minute. */
  private scheduleMinuteTick(): void {
    if (this.minuteTimer !== null) clearTimeout(this.minuteTimer);
    const now = Date.now();
    const untilNextMinute = 60_000 - (now % 60_000) + 50;
    this.minuteTimer = setTimeout(() => {
      this.minuteTimer = null;
      if (!this.requestRender) return;
      this.requestRender();
      this.scheduleMinuteTick();
    }, untilNextMinute);
  }

  paint(image: GrayImage): void {
    const large = getDefaultLargeFont();
    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    const now = new Date();

    // Clock and date down the left; batteries take the right edge.
    const batteryLeft = drawBatteryBlock(image, small, image.width - PAD, PAD);
    const textWidth = Math.max(0, batteryLeft - BATTERY_ITEM_GAP - PAD);
    const timeText = formatClockTime(now);
    const timeFont = large.measureText(timeText) <= textWidth ? large : medium;
    let y = PAD;
    image.drawText(timeFont, PAD, y, timeText, 230);
    y += timeFont.lineHeight + 2;
    image.drawText(medium, PAD, y, formatClockDate(now), 170);

    // Notification icons along the bottom, as many as fit.
    const iconY = image.height - PAD - NOTIFICATION_ICON_SIZE;
    const maxIcons = Math.max(0, ((image.width - 2 * PAD + NOTIFICATION_ICON_GAP) / (NOTIFICATION_ICON_SIZE + NOTIFICATION_ICON_GAP)) | 0);
    if (maxIcons > 0) {
      const { icons, stale } = readActiveNotificationIcons(maxIcons, renderPassAllowsStaleData());
      if (stale) noteStaleDataUsed();
      for (let index = 0; index < icons.length; index++) {
        image.drawImage(icons[index]!, PAD + index * (NOTIFICATION_ICON_SIZE + NOTIFICATION_ICON_GAP), iconY);
      }
    }
  }
}

function collectBatteryItems(): BatteryItem[] {
  const items: BatteryItem[] = [];
  const push = (visibility: BatteryIndicatorVisibility, label: string, percent: number | null, charging: boolean | null) => {
    if (percent === null || !Number.isFinite(percent)) return;
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (!batteryIndicatorVisible(visibility, clamped)) return;
    items.push({ label, percent: clamped, charging: Boolean(charging) });
  };
  const phone = readPhoneBatteryState();
  push(phoneBatteryVisibilitySetting.get(), "Phone", phone.battery, phone.charging);
  const levels = shell.getBatteryLevels();
  push(glassesBatteryVisibilitySetting.get(), "G2", levels.headset, levels.headsetCharging);
  if (levels.ring !== null && Number.isInteger(levels.ring) && levels.ring >= 0 && levels.ring <= 100) {
    push(ringBatteryVisibilitySetting.get(), "R1", levels.ring, levels.ringCharging);
  }
  return items;
}

/**
 * The battery indicators right-aligned at `right`, in the configured style.
 * Side-by-side styles put the label beside the gauge (or percentage) on one
 * line; stacked styles centre the label above it. Returns the block's left
 * edge (or `right` when nothing is shown).
 */
function drawBatteryBlock(image: GrayImage, font: UiFont, right: number, top: number): number {
  const items = collectBatteryItems();
  if (!items.length) return right;
  const mode = batteryDisplayModeSetting.get();
  const percentage = mode === "percentage" || mode === "stacked-percentage";
  const stacked = mode === "stacked" || mode === "stacked-percentage";
  const gaugeHeight = drawBattery(0, false).height;
  let x = right;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const percentText = `${item.percent}%`;
    const labelWidth = font.measureText(item.label);
    const valueWidth = percentage ? font.measureText(percentText) : BATTERY_ICON_WIDTH;
    if (stacked) {
      const itemWidth = Math.max(labelWidth, valueWidth);
      x -= itemWidth;
      image.drawText(font, x + (((itemWidth - labelWidth) / 2) | 0), top, item.label, BATTERY_LABEL_VALUE);
      drawBatteryValue(image, font, x + (((itemWidth - valueWidth) / 2) | 0), top + font.lineHeight + 2, item, percentage, gaugeHeight);
    } else {
      x -= labelWidth + 5 + valueWidth;
      image.drawText(font, x, top, item.label, BATTERY_LABEL_VALUE);
      drawBatteryValue(image, font, x + labelWidth + 5, top, item, percentage, gaugeHeight);
    }
    x -= BATTERY_ITEM_GAP;
  }
  return x + BATTERY_ITEM_GAP;
}

function drawBatteryValue(
  image: GrayImage,
  font: UiFont,
  x: number,
  lineTop: number,
  item: BatteryItem,
  percentage: boolean,
  gaugeHeight: number,
): void {
  if (percentage) {
    const percentText = `${item.percent}%`;
    if (item.charging) {
      // Inverted text marks charging, as in the top bar.
      image.fillRect(x - 2, lineTop - 1, font.measureText(percentText) + 4, font.lineHeight + 2, 255);
      image.drawText(font, x, lineTop, percentText, 1);
    } else {
      image.drawText(font, x, lineTop, percentText, 200);
    }
    return;
  }
  const icon = drawBattery(item.percent, item.charging);
  image.bitBlt(icon, x, lineTop + Math.max(0, ((font.lineHeight - gaugeHeight) / 2) | 0), { transparentZero: true });
}
