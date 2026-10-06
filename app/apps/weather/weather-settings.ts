import { ConfigSettingBoolean } from "../../ui/dashboard-settings";

/**
 * Where current conditions show outside the Weather app. While either is on
 * and the glasses are connected, the weather bridge refreshes hourly (see
 * weather-indicators.ts).
 */
export const weatherShowInStatusBarSetting = new ConfigSettingBoolean({
  id: "weather-show-in-status-bar",
  label: "Show in status bar",
  storageKey: "weather.showInStatusBar",
  defaultValue: false,
  description:
    "Show the current conditions and temperature in the top bar. Weather for your current location is fetched once an hour while the glasses are connected.",
});

export const weatherShowOnSystemCardSetting = new ConfigSettingBoolean({
  id: "weather-show-on-system-card",
  label: "Show on system card",
  storageKey: "weather.showOnSystemCard",
  defaultValue: false,
  description:
    "Show the current conditions and temperature on the Glanceboard's system card. Weather for your current location is fetched once an hour while the glasses are connected.",
});
