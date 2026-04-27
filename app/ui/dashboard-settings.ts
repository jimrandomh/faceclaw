import { ApplicationSettings } from "@nativescript/core";

export type DashboardSlotId = "top-right" | "bottom-left" | "bottom-right";
export type DashboardPluginId = "blank" | "input-debug-log" | "music-controller" | "nightscout";

export type DashboardSlotConfig = Record<DashboardSlotId, DashboardPluginId>;
export type NightscoutSettings = {
  siteUrl: string;
  apiToken: string;
};
export type SystemCardSettings = {
  showFaceclawLogo: boolean;
  showBatteryIndicators: boolean;
  showAndroidNotifications: boolean;
};
export type SystemCardSettingKey = keyof SystemCardSettings;

export const DEFAULT_SYSTEM_CARD_NAME = "Faceclaw";
const SYSTEM_CARD_NAME_KEY = "dashboard.systemCardName";
const SYSTEM_CARD_SETTING_KEYS: Record<SystemCardSettingKey, string> = {
  showFaceclawLogo: "dashboard.systemCard.showFaceclawLogo",
  showBatteryIndicators: "dashboard.systemCard.showBatteryIndicators",
  showAndroidNotifications: "dashboard.systemCard.showAndroidNotifications",
};
const NIGHTSCOUT_SITE_URL_KEY = "integrations.nightscout.siteUrl";
const NIGHTSCOUT_API_TOKEN_KEY = "integrations.nightscout.apiToken";
const SLOT_KEYS: Record<DashboardSlotId, string> = {
  "top-right": "dashboard.slot.topRight",
  "bottom-left": "dashboard.slot.bottomLeft",
  "bottom-right": "dashboard.slot.bottomRight",
};

const KNOWN_PLUGIN_IDS = new Set<DashboardPluginId>([
  "blank",
  "input-debug-log",
  "music-controller",
  "nightscout",
]);

const DEFAULT_SLOT_CONFIG: DashboardSlotConfig = {
  "top-right": "input-debug-log",
  "bottom-left": "blank",
  "bottom-right": "blank",
};

const DEFAULT_SYSTEM_CARD_SETTINGS: SystemCardSettings = {
  showFaceclawLogo: true,
  showBatteryIndicators: true,
  showAndroidNotifications: true,
};

export function getDashboardSlotIds(): DashboardSlotId[] {
  return ["top-right", "bottom-left", "bottom-right"];
}

export function getDefaultDashboardSlotConfig(): DashboardSlotConfig {
  return { ...DEFAULT_SLOT_CONFIG };
}

export function loadDashboardSlotConfig(): DashboardSlotConfig {
  const config = getDefaultDashboardSlotConfig();
  for (const slot of getDashboardSlotIds()) {
    const stored = ApplicationSettings.getString(SLOT_KEYS[slot], config[slot]);
    config[slot] = normalizePluginId(stored, config[slot]);
  }
  return config;
}

export function saveDashboardSlotPlugin(slot: DashboardSlotId, pluginId: DashboardPluginId): void {
  ApplicationSettings.setString(SLOT_KEYS[slot], pluginId);
}

export function saveDashboardSlotConfig(config: DashboardSlotConfig): void {
  for (const slot of getDashboardSlotIds()) {
    saveDashboardSlotPlugin(slot, config[slot]);
  }
}

export function loadSystemCardName(): string {
  return normalizeSystemCardName(ApplicationSettings.getString(SYSTEM_CARD_NAME_KEY, DEFAULT_SYSTEM_CARD_NAME));
}

export function saveSystemCardName(name: string): string {
  const normalized = normalizeSystemCardName(name);
  ApplicationSettings.setString(SYSTEM_CARD_NAME_KEY, normalized);
  return normalized;
}

export function loadSystemCardSettings(): SystemCardSettings {
  return {
    showFaceclawLogo: ApplicationSettings.getBoolean(
      SYSTEM_CARD_SETTING_KEYS.showFaceclawLogo,
      DEFAULT_SYSTEM_CARD_SETTINGS.showFaceclawLogo,
    ),
    showBatteryIndicators: ApplicationSettings.getBoolean(
      SYSTEM_CARD_SETTING_KEYS.showBatteryIndicators,
      DEFAULT_SYSTEM_CARD_SETTINGS.showBatteryIndicators,
    ),
    showAndroidNotifications: ApplicationSettings.getBoolean(
      SYSTEM_CARD_SETTING_KEYS.showAndroidNotifications,
      DEFAULT_SYSTEM_CARD_SETTINGS.showAndroidNotifications,
    ),
  };
}

export function saveSystemCardSetting(key: SystemCardSettingKey, value: boolean): void {
  ApplicationSettings.setBoolean(SYSTEM_CARD_SETTING_KEYS[key], value);
}

export function loadNightscoutSettings(): NightscoutSettings {
  return {
    siteUrl: normalizeNightscoutSiteUrl(ApplicationSettings.getString(NIGHTSCOUT_SITE_URL_KEY, "")),
    apiToken: normalizeNightscoutApiToken(ApplicationSettings.getString(NIGHTSCOUT_API_TOKEN_KEY, "")),
  };
}

export function saveNightscoutSiteUrl(siteUrl: string): string {
  const normalized = normalizeNightscoutSiteUrl(siteUrl);
  ApplicationSettings.setString(NIGHTSCOUT_SITE_URL_KEY, normalized);
  return normalized;
}

export function saveNightscoutApiToken(apiToken: string): string {
  const normalized = normalizeNightscoutApiToken(apiToken);
  ApplicationSettings.setString(NIGHTSCOUT_API_TOKEN_KEY, normalized);
  return normalized;
}

export function isNightscoutSettingsConfigured(settings = loadNightscoutSettings()): boolean {
  return settings.siteUrl.length > 0 && settings.apiToken.length > 0;
}

export function normalizePluginId(
  value: string | null | undefined,
  fallback: DashboardPluginId = "blank",
): DashboardPluginId {
  if (value && KNOWN_PLUGIN_IDS.has(value as DashboardPluginId)) {
    return value as DashboardPluginId;
  }
  return fallback;
}

function normalizeSystemCardName(name: string | null | undefined): string {
  const normalized = (name ?? "").replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized;
}

function normalizeNightscoutSiteUrl(siteUrl: string | null | undefined): string {
  return (siteUrl ?? "").replace(/[\x00-\x1f]+/g, "").trim().replace(/\/+$/, "");
}

function normalizeNightscoutApiToken(apiToken: string | null | undefined): string {
  return (apiToken ?? "").replace(/[\x00-\x1f]+/g, "").trim();
}
