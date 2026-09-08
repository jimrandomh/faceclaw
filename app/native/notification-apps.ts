import { Utils } from '@nativescript/core';
import { readActiveNotifications } from './notification-icons';

export type NotificationApp = { packageName: string; name: string };

/** Uses the APK's existing package-visibility permission; no new permission or app action. */
export function readNotificationApps(): NotificationApp[] {
  if (!global.isAndroid) return [];
  const apps = new Map<string, NotificationApp>();
  const context = Utils.android.getApplicationContext();
  const ownPackage = String(context.getPackageName());
  try {
    const manager = context.getPackageManager();
    const installed = manager.getInstalledApplications(0);
    for (let index = 0; index < installed.size(); index++) {
      const app = installed.get(index);
      const packageName = String(app.packageName);
      if (!packageName || packageName === ownPackage) continue;
      let name = packageName;
      try { name = String(manager.getApplicationLabel(app)) || packageName; } catch { /* Retain package label. */ }
      apps.set(packageName, { packageName, name });
    }
  } catch { /* Active notifications still provide a useful, permission-filtered catalog. */ }
  for (const notification of readActiveNotifications()) {
    if (notification.packageName && notification.packageName !== ownPackage && !apps.has(notification.packageName)) {
      apps.set(notification.packageName, { packageName: notification.packageName, name: notification.appName || notification.packageName });
    }
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name) || a.packageName.localeCompare(b.packageName));
}
