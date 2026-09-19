import { getStringSetting, setStringSetting } from "./settings-store";

const SOURCES_KEY = "notifications.sources";

export type NotificationSource = {
  packageName: string;
  appName: string;
  showOnGlasses: boolean;
};

/** Sources outlive their active notifications so a muted app can always be re-enabled. */
export function readNotificationSources(): NotificationSource[] {
  try {
    const parsed = JSON.parse(getStringSetting(SOURCES_KEY, "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((source) => source && typeof source.packageName === "string" && source.packageName)
      .map((source) => ({
        packageName: source.packageName,
        appName: typeof source.appName === "string" && source.appName ? source.appName : source.packageName,
        showOnGlasses: source.showOnGlasses !== false,
      }));
  } catch {
    return [];
  }
}

export function rememberNotificationSources(notifications: { packageName: string; appName: string }[]): void {
  const sources = new Map(readNotificationSources().map((source) => [source.packageName, source]));
  let changed = false;
  for (const notification of notifications) {
    if (!notification.packageName) continue;
    const previous = sources.get(notification.packageName);
    const appName = notification.appName || previous?.appName || notification.packageName;
    if (!previous || previous.appName !== appName) {
      sources.set(notification.packageName, {
        packageName: notification.packageName,
        appName,
        showOnGlasses: previous?.showOnGlasses ?? true,
      });
      changed = true;
    }
  }
  if (changed) setStringSetting(SOURCES_KEY, JSON.stringify(Array.from(sources.values())));
}

export function shouldShowNotificationOnGlasses(packageName: string): boolean {
  return readNotificationSources().find((source) => source.packageName === packageName)?.showOnGlasses ?? true;
}

export function setNotificationSourceEnabled(source: { packageName: string; appName: string }, enabled: boolean): void {
  if (!source.packageName) return;
  const sources = new Map(readNotificationSources().map((item) => [item.packageName, item]));
  sources.set(source.packageName, {
    packageName: source.packageName,
    appName: source.appName || source.packageName,
    showOnGlasses: enabled,
  });
  setStringSetting(SOURCES_KEY, JSON.stringify(Array.from(sources.values())));
}
