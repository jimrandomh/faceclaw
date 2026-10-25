import { GrayImage, type UiFont } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { weatherBridge } from "../../native/weather";
import { onAnySettingChanged } from "../../ui/dashboard-settings";
import { shell, type TrayWidget } from "../../ui/shell/shell";
import { isSystemCardWidgetInUse } from "../glanceboard/configuration";
import { drawWeatherReading, measureWeatherReading, weatherReading, type WeatherReading } from "./weather-icons";
import { weatherShowInStatusBarSetting, weatherShowOnSystemCardSetting } from "./weather-settings";

const TRAY_ICON_ID = "weather";
const TRAY_HEIGHT = 24;
const TRAY_ICON_SIZE = 20;

let started = false;
let trayWidget: TrayWidget | undefined;
/** What the tray currently shows, to skip rebuilding an unchanged icon. */
let trayShown: { key: string; font: UiFont } | null = null;

/**
 * Shell-lifetime subscription: keeps the hourly background refresh running
 * while the status-bar indicator is enabled, or the system-card one is and
 * the system card is on an enabled Glanceboard, and the tray icon in sync.
 * The system card reads the bridge itself while it shows. `widget` makes
 * the tray icon selectable in the switcher.
 */
export function startWeatherIndicators(widget?: TrayWidget): void {
  if (started) return;
  started = true;
  trayWidget = widget;
  weatherBridge.onStateChange(syncWeatherIndicators);
  onAnySettingChanged(syncWeatherIndicators);
}

function syncWeatherIndicators(): void {
  const inStatusBar = weatherShowInStatusBarSetting.get();
  weatherBridge.setBackgroundRefresh(inStatusBar || (weatherShowOnSystemCardSetting.get() && isSystemCardWidgetInUse()));

  const reading = inStatusBar ? weatherReading(weatherBridge.snapshot(), Date.now()) : null;
  const font = getDefaultSmallFont();
  const key = reading ? `${reading.condition}|${reading.isDaytime}|${reading.temperature}` : null;
  if (key === (trayShown?.key ?? null) && (!trayShown || trayShown.font === font)) return;
  trayShown = key === null ? null : { key, font };
  shell.setTrayIcon(TRAY_ICON_ID, reading ? buildWeatherTrayIcon(reading, font) : null, trayWidget);
}

/** Condition icon and temperature, baked to a raster so the tray keeps one stable image. */
function buildWeatherTrayIcon(reading: WeatherReading, font: UiFont): GrayImage {
  const image = new GrayImage(Math.ceil(measureWeatherReading(reading, font, TRAY_ICON_SIZE)), TRAY_HEIGHT, 0);
  drawWeatherReading(image, reading, font, TRAY_ICON_SIZE, 0, 0, TRAY_HEIGHT, 220);
  return image.withDrawsBaked();
}
