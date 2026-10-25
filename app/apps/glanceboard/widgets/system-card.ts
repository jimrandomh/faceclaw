import {
  BATTERY_ICON_WIDTH,
  DENSE_BATTERY_BLOCK_HEIGHT,
  denseBatteriesWidth,
  drawBattery,
  drawDenseBatteries,
  type BatteryDevice,
} from "../../../graphics/battery";
import { type GrayImage, type UiFont } from "../../../graphics/image";
import { ensureLocationPermission, hasLocationPermission } from "../../../native/location-permissions";
import { onAndroidNotificationsChanged, readActiveNotificationIcons } from "../../../native/notification-icons";
import { readPhoneBatteryState } from "../../../native/phone-battery";
import { weatherBridge } from "../../../native/weather";
import { formatClockDate, formatClockTime } from "../../../ui/clock-format";
import {
  batteryDisplayModeSetting,
  batteryIndicatorVisible,
  ConfigSettingBoolean,
  glassesBatteryVisibilitySetting,
  onAnySettingChanged,
  phoneBatteryVisibilitySetting,
  ringBatteryVisibilitySetting,
  toggleSettingMenuItem,
  watchBatteryVisibilitySetting,
  type BatteryIndicatorVisibility,
} from "../../../ui/dashboard-settings";
import { type MenuItem } from "../../../ui/menu";
import { shell } from "../../../ui/shell/shell";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../../../util/render-freshness";
import { truncateText } from "../../../graphics/textwrap";
import { timerEngine } from "../../timer/timer-engine";
import { formatCountdown, sortTimers, timerDisplayName, timerPhase, timerRemainingMs } from "../../timer/timer-model";
import { lineStep } from "../../../ui/metrics";
import { drawWeatherReading, measureWeatherReading, weatherReading } from "../../weather/weather-icons";
import { weatherShowOnSystemCardSetting } from "../../weather/weather-settings";
import { glanceFont } from "../glance-font";
import { type GlanceWidget } from "../widget";

const PAD = 8;
const NOTIFICATION_ICON_SIZE = 24;
const NOTIFICATION_ICON_GAP = 4;
const BATTERY_ITEM_GAP = 12;
const BATTERY_LABEL_VALUE = 150;
/** Gap between the battery block and the weather reading stacked after it. */
const SIDE_BLOCK_GAP = 6;
/** Rows between the time and the date. */
const CLOCK_LINE_GAP = 2;
/** Rows between the clock and the timers, and between the timers and the notification icons. */
const TIMERS_GAP = 4;
const TIMER_NAME_GAP = 8;

type BatteryItem = { label: string; device: BatteryDevice; percent: number; charging: boolean };
type Rect = { x: number; y: number; width: number; height: number };
/** A side-column block, measured so it can be placed against either edge before it is drawn. */
type SideBlock = { width: number; height: number; draw: (image: GrayImage, left: number, top: number) => void };
/** The main column's horizontal extent on some rows. */
type Span = { left: number; right: number };

export const systemCardShowTimeSetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-show-time",
  label: "Time",
  storageKey: "glanceboard.systemCard.showTime",
  defaultValue: true,
  description: "Show the clock on the system card.",
});

export const systemCardShowDateSetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-show-date",
  label: "Date",
  storageKey: "glanceboard.systemCard.showDate",
  defaultValue: true,
  description: "Show the date on the system card, under the time.",
});

export const systemCardShowBatterySetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-show-battery",
  label: "Battery",
  storageKey: "glanceboard.systemCard.showBattery",
  defaultValue: true,
  description:
    "Show battery indicators on the system card. Their style and which devices appear follow Settings > Customization > Battery indicators.",
});

export const systemCardShowNotificationsSetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-show-notifications",
  label: "Notifications",
  storageKey: "glanceboard.systemCard.showNotifications",
  defaultValue: true,
  description: "Show the icons of the phone's notifications along the edge of the system card.",
});

export const systemCardFlipHorizontalSetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-flip-horizontal",
  label: "Flip layout horizontally",
  storageKey: "glanceboard.systemCard.flipHorizontal",
  defaultValue: false,
  description:
    "Mirror the system card left to right: time, date, timers and notifications on the right, batteries and weather on the left.",
});

export const systemCardFlipVerticalSetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-flip-vertical",
  label: "Flip layout vertically",
  storageKey: "glanceboard.systemCard.flipVertical",
  defaultValue: false,
  description:
    "Mirror the system card top to bottom: notifications along the top; time, date, batteries and weather along the bottom.",
});

/**
 * The system card's submenu in Glanceboard > Settings. Weather is the
 * Weather app's "Show on system card" setting under a shorter label.
 */
export function systemCardSettingsMenuItems(): MenuItem[] {
  return [
    toggleSettingMenuItem(systemCardShowTimeSetting),
    toggleSettingMenuItem(systemCardShowDateSetting),
    toggleSettingMenuItem(systemCardShowBatterySetting),
    toggleSettingMenuItem(weatherShowOnSystemCardSetting, {
      label: "Weather",
      onChange: (_ctx, enabled) => {
        if (enabled) requestWeatherLocationAccess();
      },
    }),
    toggleSettingMenuItem(systemCardShowNotificationsSetting),
    toggleSettingMenuItem(systemCardFlipHorizontalSetting),
    toggleSettingMenuItem(systemCardFlipVerticalSetting),
  ];
}

/**
 * Weather switched on without location access: ask for it now, as the
 * Weather app's own toggle does, since the background refresh has no screen
 * to prompt from.
 */
function requestWeatherLocationAccess(): void {
  if (hasLocationPermission()) return;
  void ensureLocationPermission().then((granted) => {
    if (granted) void weatherBridge.refreshNow();
  }).catch((error) => console.warn(`Weather permission: ${error}`));
}

/**
 * Date and time, the phone's notification icons, the phone/watch/G2/R1
 * battery indicators (the Wear OS watch's only while one is reachable), the
 * current weather, and the Timers app's countdowns: the top bar's contents
 * plus timers, laid out for a card. Every part but the timers can be turned
 * off, and the layout mirrored either way, in the card's submenu of
 * Glanceboard > Settings. Battery style and per-device visibility follow
 * Settings > Customization > Battery indicators, so the card agrees with
 * the bar. Countdowns tick once a second only while one is running.
 */
export class SystemCardWidget implements GlanceWidget {
  private requestRender: (() => void) | null = null;
  private minuteTimer: ReturnType<typeof setTimeout> | null = null;
  private secondTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeNotifications: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeTimers: (() => void) | null = null;
  private unsubscribeWeather: (() => void) | null = null;

  start(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.scheduleMinuteTick();
    this.unsubscribeNotifications = onAndroidNotificationsChanged(() => this.requestRender?.());
    this.unsubscribeSettings = onAnySettingChanged(() => this.requestRender?.());
    this.unsubscribeTimers = timerEngine.onChange(() => {
      this.syncSecondTick();
      this.requestRender?.();
    });
    // The Weather app's indicator keeps the bridge refreshing; this only listens.
    this.unsubscribeWeather = weatherBridge.onStateChange(() => this.requestRender?.());
    this.syncSecondTick();
  }

  stop(): void {
    this.requestRender = null;
    if (this.minuteTimer !== null) clearTimeout(this.minuteTimer);
    this.minuteTimer = null;
    if (this.secondTimer !== null) clearInterval(this.secondTimer);
    this.secondTimer = null;
    this.unsubscribeNotifications?.();
    this.unsubscribeNotifications = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.unsubscribeTimers?.();
    this.unsubscribeTimers = null;
    this.unsubscribeWeather?.();
    this.unsubscribeWeather = null;
  }

  /** Countdowns change every second; run that clock only while one is running. */
  private syncSecondTick(): void {
    const running = timerEngine.timers().some((timer) => timerPhase(timer) === "running");
    if (running && this.secondTimer === null) {
      this.secondTimer = setInterval(() => this.requestRender?.(), 1_000);
    } else if (!running && this.secondTimer !== null) {
      clearInterval(this.secondTimer);
      this.secondTimer = null;
    }
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
    const large = glanceFont.large();
    const medium = glanceFont.medium();
    const small = glanceFont.small();
    const now = new Date();
    const { width, height } = image;

    // Unflipped, the time and date run down the left from the top, the
    // batteries and then the weather stack down the right edge, and the
    // notification icons take the bottom row, with the timers in the band
    // between the date and the icons. The flips mirror where each block sits
    // (positions below are given for the unflipped card), not what is inside
    // it: the time stays above the date, and timers read soonest first.
    const flipX = systemCardFlipHorizontalSetting.get();
    const flipY = systemCardFlipVerticalSetting.get();
    const placeX = (x: number, w: number): number => (flipX ? width - x - w : x);
    const placeY = (y: number, h: number): number => (flipY ? height - y - h : y);

    const sideBlocks: SideBlock[] = [];
    const batteryItems = systemCardShowBatterySetting.get() ? collectBatteryItems() : [];
    if (batteryItems.length) sideBlocks.push(batteryBlock(small, batteryItems));
    const weather = weatherShowOnSystemCardSetting.get() ? weatherBlock(medium, now.getTime()) : null;
    if (weather) sideBlocks.push(weather);
    const side: Rect[] = [];
    let sideOffset = PAD;
    for (const block of sideBlocks) {
      const rect = {
        x: placeX(width - PAD - block.width, block.width),
        y: placeY(sideOffset, block.height),
        width: block.width,
        height: block.height,
      };
      block.draw(image, rect.x, rect.y);
      side.push(rect);
      sideOffset += block.height + SIDE_BLOCK_GAP;
    }
    // Text in the main column stops short of whichever side blocks share its
    // rows, and hugs the card's outer edge.
    const span = (top: number, bottom: number): Span => {
      let left = PAD;
      let right = width - PAD;
      for (const rect of side) {
        if (rect.y >= bottom || rect.y + rect.height <= top) continue;
        if (flipX) left = Math.max(left, rect.x + rect.width + BATTERY_ITEM_GAP);
        else right = Math.min(right, rect.x - BATTERY_ITEM_GAP);
      }
      return { left, right };
    };
    const lineX = ({ left, right }: Span, lineWidth: number): number => (flipX ? right - lineWidth : left);

    const showTime = systemCardShowTimeSetting.get();
    const showDate = systemCardShowDateSetting.get();
    const timeText = formatClockTime(now);
    const dateText = formatClockDate(now);
    const clockHeight = (timeFont: UiFont): number =>
      (showTime ? timeFont.lineHeight : 0) + (showTime && showDate ? CLOCK_LINE_GAP : 0) + (showDate ? medium.lineHeight : 0);
    // The time drops to the medium font when the large one would run into a side block.
    let timeFont = large;
    if (showTime) {
      const top = placeY(PAD, clockHeight(large));
      const { left, right } = span(top, top + large.lineHeight);
      if (large.measureText(timeText) > right - left) timeFont = medium;
    }
    const clockSize = clockHeight(timeFont);
    let y = placeY(PAD, clockSize);
    if (showTime) {
      image.drawText(timeFont, lineX(span(y, y + timeFont.lineHeight), timeFont.measureText(timeText)), y, timeText, 230);
      y += timeFont.lineHeight + CLOCK_LINE_GAP;
    }
    if (showDate) {
      image.drawText(medium, lineX(span(y, y + medium.lineHeight), medium.measureText(dateText)), y, dateText, 170);
    }

    const showNotifications = systemCardShowNotificationsSetting.get();
    const bandTop = clockSize > 0 ? PAD + clockSize + TIMERS_GAP : PAD;
    const bandBottom = height - PAD - (showNotifications ? NOTIFICATION_ICON_SIZE + TIMERS_GAP : 0);
    drawTimers(image, small, {
      top: placeY(bandTop, bandBottom - bandTop),
      height: bandBottom - bandTop,
      fromBottom: flipY,
      alignRight: flipX,
      span,
    }, now.getTime());

    // Notification icons, as many as fit, the first nearest the main column's edge.
    const maxIcons = Math.max(0, ((width - 2 * PAD + NOTIFICATION_ICON_GAP) / (NOTIFICATION_ICON_SIZE + NOTIFICATION_ICON_GAP)) | 0);
    if (showNotifications && maxIcons > 0) {
      const { icons, stale } = readActiveNotificationIcons(maxIcons, renderPassAllowsStaleData());
      if (stale) noteStaleDataUsed();
      const iconY = placeY(height - PAD - NOTIFICATION_ICON_SIZE, NOTIFICATION_ICON_SIZE);
      for (let index = 0; index < icons.length; index++) {
        image.drawImage(icons[index]!, placeX(PAD + index * (NOTIFICATION_ICON_SIZE + NOTIFICATION_ICON_GAP), NOTIFICATION_ICON_SIZE), iconY);
      }
    }
  }
}

function collectBatteryItems(): BatteryItem[] {
  const items: BatteryItem[] = [];
  const push = (
    visibility: BatteryIndicatorVisibility,
    label: string,
    device: BatteryDevice,
    percent: number | null,
    charging: boolean | null,
  ) => {
    if (percent === null || !Number.isFinite(percent)) return;
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (!batteryIndicatorVisible(visibility, clamped)) return;
    items.push({ label, device, percent: clamped, charging: Boolean(charging) });
  };
  const phone = readPhoneBatteryState();
  push(phoneBatteryVisibilitySetting.get(), "Phone", "phone", phone.battery, phone.charging);
  const levels = shell.getBatteryLevels();
  push(watchBatteryVisibilitySetting.get(), "Watch", "watch", levels.watch, levels.watchCharging);
  push(glassesBatteryVisibilitySetting.get(), "G2", "glasses", levels.headset, levels.headsetCharging);
  if (levels.ring !== null && Number.isInteger(levels.ring) && levels.ring >= 0 && levels.ring <= 100) {
    push(ringBatteryVisibilitySetting.get(), "R1", "ring", levels.ring, levels.ringCharging);
  }
  return items;
}

/**
 * The battery indicators in the configured style. Side-by-side styles put
 * the label beside the gauge (or percentage) on one line; stacked styles
 * centre the label above it; the dense style swaps labels for device icons
 * and stacks two indicators per column, as in the top bar.
 */
function batteryBlock(font: UiFont, items: readonly BatteryItem[]): SideBlock {
  const mode = batteryDisplayModeSetting.get();
  if (mode === "dense") {
    const width = denseBatteriesWidth(items);
    return {
      width,
      height: DENSE_BATTERY_BLOCK_HEIGHT,
      draw: (image, left, top) => {
        drawDenseBatteries(image, items, left + width, top);
      },
    };
  }
  const percentage = mode === "percentage" || mode === "stacked-percentage";
  const stacked = mode === "stacked" || mode === "stacked-percentage";
  const gaugeHeight = drawBattery(0, false).height;
  const valueHeight = percentage ? font.lineHeight : Math.max(font.lineHeight, gaugeHeight);
  const cells = items.map((item) => {
    const labelWidth = font.measureText(item.label);
    const valueWidth = percentage ? font.measureText(`${item.percent}%`) : BATTERY_ICON_WIDTH;
    return { item, labelWidth, valueWidth, width: stacked ? Math.max(labelWidth, valueWidth) : labelWidth + 5 + valueWidth };
  });
  return {
    width: cells.reduce((total, cell) => total + cell.width, 0) + BATTERY_ITEM_GAP * (cells.length - 1),
    height: (stacked ? font.lineHeight + 2 : 0) + valueHeight,
    draw: (image, left, top) => {
      let x = left;
      for (const { item, labelWidth, valueWidth, width } of cells) {
        if (stacked) {
          image.drawText(font, x + (((width - labelWidth) / 2) | 0), top, item.label, BATTERY_LABEL_VALUE);
          drawBatteryValue(image, font, x + (((width - valueWidth) / 2) | 0), top + font.lineHeight + 2, item, percentage, gaugeHeight);
        } else {
          image.drawText(font, x, top, item.label, BATTERY_LABEL_VALUE);
          drawBatteryValue(image, font, x + labelWidth + 5, top, item, percentage, gaugeHeight);
        }
        x += width + BATTERY_ITEM_GAP;
      }
    },
  };
}

/** The current weather's condition icon and temperature, or null without a fresh reading. */
function weatherBlock(font: UiFont, nowMs: number): SideBlock | null {
  const reading = weatherReading(weatherBridge.snapshot(), nowMs);
  if (!reading) return null;
  const iconSize = font.lineHeight + 4;
  const height = Math.max(iconSize, font.lineHeight);
  return {
    width: Math.ceil(measureWeatherReading(reading, font, iconSize)),
    height,
    draw: (image, left, top) => drawWeatherReading(image, reading, font, iconSize, left, top, height, 200),
  };
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

/**
 * The Timers app's countdowns, soonest first: remaining time (or "Done" once
 * rung, inverted so it is noticed; "paused" for a paused one) and the
 * timer's name, one per line, as many as fit in the band. The lines sit
 * against the band's top (or its bottom), each as wide as the main column
 * allows on its rows and hugging its left (or right) edge.
 */
function drawTimers(
  image: GrayImage,
  font: UiFont,
  band: { top: number; height: number; fromBottom: boolean; alignRight: boolean; span: (top: number, bottom: number) => Span },
  nowMs: number,
): void {
  const step = lineStep(font);
  const fit = band.height < font.lineHeight ? 0 : 1 + Math.floor((band.height - font.lineHeight) / step);
  const timers = sortTimers(timerEngine.timers(), nowMs).slice(0, fit);
  if (!timers.length) return;
  let y = band.fromBottom ? band.top + band.height - (timers.length - 1) * step - font.lineHeight : band.top;
  for (const timer of timers) {
    const { left, right } = band.span(y, y + font.lineHeight);
    const phase = timerPhase(timer);
    const clock = phase === "rung" ? "Done" : formatCountdown(timerRemainingMs(timer, nowMs));
    const nameOffset = font.measureText(clock) + TIMER_NAME_GAP;
    const fullName = phase === "paused" ? `${timerDisplayName(timer)} (paused)` : timerDisplayName(timer);
    const name = truncateText(font, fullName, Math.max(0, right - left - nameOffset));
    const x = band.alignRight ? right - nameOffset - font.measureText(name) : left;
    if (phase === "rung") {
      image.fillRect(x - 2, y - 1, nameOffset - TIMER_NAME_GAP + 4, font.lineHeight + 2, 230);
      image.drawText(font, x, y, clock, 1);
    } else {
      image.drawText(font, x, y, clock, phase === "paused" ? 120 : 200);
    }
    image.drawText(font, x + nameOffset, y, name, 160);
    y += step;
  }
}
