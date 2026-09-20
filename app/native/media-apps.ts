import { getStringSetting, setStringSetting } from "./settings-store";

export const MEDIA_APPS_KEY = "music.apps";

// Exact package IDs only: browsers, social feeds and messaging apps commonly
// publish sessions for embedded clips. Users can explicitly enable any of them.
export const DEFAULT_IGNORED_MEDIA_APPS: readonly string[] = [
  "com.android.chrome",
  "org.mozilla.firefox",
  "com.microsoft.emmx",
  "com.sec.android.app.sbrowser",
  "com.facebook.katana",
  "com.facebook.orca",
  "com.instagram.android",
  "com.whatsapp",
  "org.telegram.messenger",
  "com.snapchat.android",
  "com.reddit.frontpage",
  "com.twitter.android",
  "com.discord",
];

export type MediaApp = {
  packageName: string;
  appName: string;
  /** Absent until the user chooses; built-in defaults can evolve independently. */
  enabled?: boolean;
};

/** Keep discovered apps after their sessions end, including ignored apps. */
export function readMediaApps(): MediaApp[] {
  try {
    const parsed = JSON.parse(getStringSetting(MEDIA_APPS_KEY, "[]"));
    if (!Array.isArray(parsed)) return [];
    const apps = new Map<string, MediaApp>();
    for (const app of parsed) {
      if (!app || typeof app.packageName !== "string" || !app.packageName) continue;
      apps.set(app.packageName, {
        packageName: app.packageName,
        appName: typeof app.appName === "string" && app.appName ? app.appName : app.packageName,
        ...(typeof app.enabled === "boolean" ? { enabled: app.enabled } : {}),
      });
    }
    return Array.from(apps.values());
  } catch {
    return [];
  }
}

export function rememberMediaApps(discovered: { packageName: string; appName: string }[]): void {
  const apps = new Map(readMediaApps().map((app) => [app.packageName, app]));
  let changed = false;
  for (const app of discovered) {
    if (!app.packageName) continue;
    const previous = apps.get(app.packageName);
    const appName = app.appName || previous?.appName || app.packageName;
    if (!previous || previous.appName !== appName) {
      apps.set(app.packageName, { ...previous, packageName: app.packageName, appName });
      changed = true;
    }
  }
  if (changed) setStringSetting(MEDIA_APPS_KEY, JSON.stringify(Array.from(apps.values())));
}

export function ignoredMediaPackages(): string[] {
  const ignored = new Set(DEFAULT_IGNORED_MEDIA_APPS);
  for (const app of readMediaApps()) {
    if (app.enabled === true) ignored.delete(app.packageName);
    else if (app.enabled === false) ignored.add(app.packageName);
  }
  return Array.from(ignored).sort();
}

export function isMediaAppEnabled(packageName: string): boolean {
  return !ignoredMediaPackages().includes(packageName);
}

export function setMediaAppEnabled(app: MediaApp, enabled: boolean): void {
  if (!app.packageName) return;
  const apps = new Map(readMediaApps().map((item) => [item.packageName, item]));
  apps.set(app.packageName, { packageName: app.packageName, appName: app.appName || app.packageName, enabled });
  setStringSetting(MEDIA_APPS_KEY, JSON.stringify(Array.from(apps.values())));
}
