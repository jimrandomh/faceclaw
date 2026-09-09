import { renderIcon } from "../graphics/icons";
import { externalNotifications, invokeExternalNotification, dismissExternalNotification } from "./external-notifications";
import type { AndroidNotification, AndroidNotificationAction } from "./notification-types";
export type { AndroidNotification, AndroidNotificationAction } from "./notification-types";
import { GrayImage } from "../graphics/image";
import { logCurrent, spanCurrent } from "./frame-timings";
import { toUint8Array } from "../util/array-util";
import { rememberNotificationSources } from "./notification-sources";

declare const com: any;

const ICON_SIZE = 24;
/** Ask the native listener for every active source, including those below the list's display limit. */
export const ALL_NOTIFICATIONS = 0x7fffffff;
// Backstop TTL only: the icon caches are invalidated eagerly whenever a
// notification is posted or dismissed (see invalidateIconCaches callers), so
// the tray is kept fresh by invalidation, not by expiry. A short TTL just
// forced a blocking main-thread re-fetch (~40-100ms of Java icon
// rasterization) every few seconds — usually producing a no-change frame that
// was then discarded. A long backstop keeps that off the render hot path.
const ICON_CACHE_MS = 60_000;

let cachedIcons: GrayImage[] = [];
let cachedAtMs = 0;
const keyedIconCache = new Map<string, { icon: GrayImage | null; atMs: number }>();
const KEYED_ICON_CACHE_MAX = 128;
let notificationListenerProxy: any | null = null;
const notificationRemovedListeners = new Set<(notificationKey: string) => void>();
const notificationPostedListeners = new Set<(notificationKey: string) => void>();
const notificationChangedListeners = new Set<() => void>();

function invalidateIconCaches(): void {
  cachedAtMs = 0;
  keyedIconCache.clear();
}

export type NotificationIconsResult = {
  icons: GrayImage[];
  /** True when the icons came from an expired (or empty) cache under allowStale. */
  stale: boolean;
};

/**
 * With allowStale, this always returns immediately: expired cached icons (or
 * none at all, right after startup or a cache invalidation) come back with
 * stale=true, and the caller is expected to repaint with allowStale=false
 * once the current frame is done. Only an allowStale=false call actually
 * fetches from the notification listener service, which can be slow depending
 * on what is in the tray.
 */
export function readActiveNotificationIcons(maxIcons: number, allowStale: boolean): NotificationIconsResult {
  if (!global.isAndroid || maxIcons <= 0) return { icons: [], stale: false };

  const externalIcon = externalNotifications().length ? renderIcon("package", ICON_SIZE) : null;
  const withExternal = (icons: GrayImage[]): GrayImage[] => externalIcon ? [externalIcon, ...icons].slice(0, maxIcons) : icons;
  const now = Date.now();
  if (cachedAtMs > 0 && now - cachedAtMs < ICON_CACHE_MS) {
    logCurrent("notification icons served from cache");
    return { icons: withExternal(cachedIcons.map(icon => icon.clone())), stale: false };
  }
  if (allowStale) {
    logCurrent("notification icons served stale");
    return { icons: withExternal(cachedIcons.map(icon => icon.clone())), stale: true };
  }

  const bytes = spanCurrent("fetch-notification-icons", () =>
    toUint8Array(
      com.faceclaw.app.FaceclawMediaNotificationListenerService.getActiveNotificationIconGrays(
        ICON_SIZE,
        maxIcons,
      ),
    ),
  );
  const iconByteLength = ICON_SIZE * ICON_SIZE;
  const iconCount = Math.floor(bytes.length / iconByteLength);
  const icons: GrayImage[] = [];
  for (let index = 0; index < iconCount; index++) {
    const icon = new GrayImage(ICON_SIZE, ICON_SIZE, 0);
    icon.pixels.set(bytes.subarray(index * iconByteLength, (index + 1) * iconByteLength));
    icons.push(icon);
  }

  cachedIcons = icons;
  cachedAtMs = now;
  return { icons: withExternal(icons.map(icon => icon.clone())), stale: false };
}

export type NotificationIconResult = {
  icon: GrayImage | null;
  /** True when the icon came from an expired (or empty) cache under allowStale. */
  stale: boolean;
};

/**
 * Icon for one notification, identified by its key, with the same allow-stale
 * contract as readActiveNotificationIcons: an allowStale call never blocks on
 * the notification listener service, and stale=true asks the caller to repaint
 * with allowStale=false once the current frame is done. A null icon with
 * stale=false is definitive (notification gone or icon unavailable) and is
 * cached too, so failing icons do not refetch every paint.
 */
export function readNotificationIconByKey(key: string, allowStale: boolean): NotificationIconResult {
  if (!global.isAndroid || !key) return { icon: null, stale: false };

  const now = Date.now();
  const cached = keyedIconCache.get(key);
  if (cached && now - cached.atMs < ICON_CACHE_MS) {
    return { icon: cached.icon?.clone() ?? null, stale: false };
  }
  if (allowStale) {
    return { icon: cached?.icon?.clone() ?? null, stale: true };
  }

  const bytes = spanCurrent("fetch-notification-icon", () =>
    toUint8Array(
      com.faceclaw.app.FaceclawMediaNotificationListenerService.getNotificationIconGrayForKey(
        key,
        ICON_SIZE,
      ),
    ),
  );
  let icon: GrayImage | null = null;
  if (bytes.length >= ICON_SIZE * ICON_SIZE) {
    icon = new GrayImage(ICON_SIZE, ICON_SIZE, 0);
    icon.pixels.set(bytes.subarray(0, ICON_SIZE * ICON_SIZE));
  }
  keyedIconCache.delete(key);
  keyedIconCache.set(key, { icon, atMs: now });
  while (keyedIconCache.size > KEYED_ICON_CACHE_MAX) {
    const oldestKey = keyedIconCache.keys().next().value;
    if (oldestKey === undefined) break;
    keyedIconCache.delete(oldestKey);
  }
  return { icon: icon?.clone() ?? null, stale: false };
}

export function readActiveNotifications(maxNotifications = 50, includeExternal = false): AndroidNotification[] {
  // Assistant tools use the default path. App-specific private content is UI-only.
  const extra = includeExternal ? externalNotifications() : [];
  if (!global.isAndroid || maxNotifications <= 0) return extra.slice(0, Math.max(0, maxNotifications));
  try {
    const json = spanCurrent("fetch-notifications-json", () =>
      String(
        com.faceclaw.app.FaceclawMediaNotificationListenerService.getActiveNotificationsJson(
          Math.max(0, Math.round(maxNotifications)),
        ),
      ),
    );
    const parsed = JSON.parse(json);
    const native: AndroidNotification[] = Array.isArray(parsed) ? parsed.map(normalizeNotification).filter((item): item is AndroidNotification => Boolean(item)) : [];
    const notifications = [...extra, ...native].sort((a, b) => b.postTime - a.postTime);
    // Remember APK sources for the same popup filter without exposing their content to tools.
    rememberNotificationSources(notifications);
    return notifications.slice(0, maxNotifications);
  } catch {
    return extra.slice(0, maxNotifications);
  }
}

export function invokeNotificationAction(notificationKey: string, actionIndex: number): boolean {
  if (notificationKey.startsWith("apk:")) return invokeExternalNotification(notificationKey, actionIndex);
  if (!global.isAndroid || !notificationKey) return false;
  invalidateIconCaches();
  return Boolean(
    com.faceclaw.app.FaceclawMediaNotificationListenerService.invokeNotificationAction(
      notificationKey,
      Math.round(actionIndex),
    ),
  );
}

export function dismissNotification(notificationKey: string, expectedPostTime?: number): boolean {
  if (notificationKey.startsWith("apk:")) return dismissExternalNotification(notificationKey, expectedPostTime);
  if (!global.isAndroid || !notificationKey) return false;
  if (expectedPostTime !== undefined && (!Number.isSafeInteger(expectedPostTime) || expectedPostTime < 0)) return false;
  invalidateIconCaches();
  if (expectedPostTime !== undefined) return Boolean(com.faceclaw.app.FaceclawMediaNotificationListenerService.dismissNotificationAtVersion(notificationKey, expectedPostTime));
  return Boolean(
    com.faceclaw.app.FaceclawMediaNotificationListenerService.dismissNotification(notificationKey),
  );
}

export function publishExternalNotificationPosted(key: string): void {
  invalidateIconCaches();
  for (const listener of [...notificationChangedListeners]) { try { listener(); } catch { /* Isolate UI consumers. */ } }
  for (const listener of [...notificationPostedListeners]) listener(key);
}

export function onAndroidNotificationPosted(listener: (notificationKey: string) => void): () => void {
  notificationPostedListeners.add(listener);
  ensureNotificationPostedListener();
  return () => {
    notificationPostedListeners.delete(listener);
    if (notificationPostedListeners.size === 0 && notificationRemovedListeners.size === 0 && notificationChangedListeners.size === 0) {
      removeNotificationPostedListener();
    }
  };
}

function normalizeNotification(value: any): AndroidNotification | null {
  if (!value || typeof value !== "object") return null;
  const key = String(value.key ?? "");
  if (!key) return null;
  const actions = Array.isArray(value.actions)
    ? value.actions.map(normalizeAction).filter((item): item is AndroidNotificationAction => Boolean(item))
    : [];
  return {
    key,
    packageName: String(value.packageName ?? ""),
    appName: String(value.appName ?? value.packageName ?? ""),
    title: String(value.title ?? ""),
    text: String(value.text ?? ""),
    bigText: String(value.bigText ?? ""),
    subText: String(value.subText ?? ""),
    infoText: String(value.infoText ?? ""),
    summaryText: String(value.summaryText ?? ""),
    category: String(value.category ?? ""),
    groupKey: String(value.groupKey ?? ""),
    isGroupSummary: value.isGroupSummary === true,
    isForegroundService: value.isForegroundService === true,
    isOngoing: value.isOngoing === true,
    userId: Number.isSafeInteger(value.userId) && value.userId >= 0 ? value.userId : undefined,
    conversationId: typeof value.conversationId === 'string' && value.conversationId.length <= 1024 ? value.conversationId : '',
    messages: Array.isArray(value.messages) ? value.messages.slice(-50).filter(item => item && Number.isSafeInteger(item.timestamp) && item.timestamp >= 0).map(item => ({
      text: String(item.text ?? '').slice(0, 8192), sender: String(item.sender ?? '').slice(0, 256), timestamp: item.timestamp, attachment: item.attachment === true,
    })) : [],
    lines: Array.isArray(value.lines) ? value.lines.map((line: unknown) => String(line)).filter(Boolean) : [],
    postTime: Number(value.postTime) || 0,
    when: Number(value.when) || 0,
    actions,
  };
}

function ensureNotificationPostedListener(): void {
  if (!global.isAndroid || notificationListenerProxy) return;
  notificationListenerProxy = new com.faceclaw.app.FaceclawNotificationListener({
    onNotificationsChanged: () => {
      invalidateIconCaches();
      const listeners = Array.from(notificationChangedListeners);
      setTimeout(() => { for (const listener of listeners) { try { listener(); } catch { /* Isolate snapshot consumers. */ } } }, 0);
    },
    onNotificationRemoved: (notificationKey: string) => {
      invalidateIconCaches();
      const key = String(notificationKey);
      const listeners = Array.from(notificationRemovedListeners);
      setTimeout(() => {
        for (const listener of listeners) {
          try { listener(key); } catch { /* A consumer cannot block tray/inbox synchronization. */ }
        }
      }, 0);
    },
    onNotificationPosted: (notificationKey: string) => {
      invalidateIconCaches();
      const key = String(notificationKey);
      if (key && !readActiveNotifications(100).some((entry) => entry.key === key)) return;
      const listeners = Array.from(notificationPostedListeners);
      setTimeout(() => {
        for (const listener of listeners) {
          listener(key);
        }
      }, 0);
    },
  });
  com.faceclaw.app.FaceclawMediaNotificationListenerService.addNotificationListener(
    notificationListenerProxy,
  );
}

function removeNotificationPostedListener(): void {
  if (!global.isAndroid || !notificationListenerProxy) return;
  com.faceclaw.app.FaceclawMediaNotificationListenerService.removeNotificationListener(
    notificationListenerProxy,
  );
  notificationListenerProxy = null;
}

function normalizeAction(value: any): AndroidNotificationAction | null {
  if (!value || typeof value !== "object") return null;
  const title = String(value.title ?? "");
  if (!title) return null;
  const index = Number(value.index);
  if (!Number.isFinite(index)) return null;
  return {
    index,
    title,
    enabled: Boolean(value.enabled),
    acceptsText: value.acceptsText === true,
  };
}

export function onAndroidNotificationRemoved(listener: (key: string) => void): () => void {
  notificationRemovedListeners.add(listener); ensureNotificationPostedListener();
  return () => { notificationRemovedListeners.delete(listener); if (!notificationRemovedListeners.size && !notificationPostedListeners.size && !notificationChangedListeners.size) removeNotificationPostedListener(); };
}
export function onAndroidNotificationsChanged(listener: () => void): () => void {
  notificationChangedListeners.add(listener); ensureNotificationPostedListener();
  return () => { notificationChangedListeners.delete(listener); if (!notificationRemovedListeners.size && !notificationPostedListeners.size && !notificationChangedListeners.size) removeNotificationPostedListener(); };
}
export function replyToNotification(key: string, actionIndex: number, expectedPostTime: number, text: string): boolean {
  if (key.startsWith("apk:")) return false;
  if (!global.isAndroid || !Number.isInteger(actionIndex) || !Number.isSafeInteger(expectedPostTime)) return false;
  return Boolean(com.faceclaw.app.FaceclawMediaNotificationListenerService.replyToNotification(key, actionIndex, expectedPostTime, text));
}

export function invokeNotificationActionAtVersion(key: string, actionIndex: number, expectedPostTime: number): boolean {
  if (key.startsWith("apk:")) return false;
  if (!global.isAndroid || !Number.isInteger(actionIndex) || !Number.isSafeInteger(expectedPostTime)) return false;
  return Boolean(com.faceclaw.app.FaceclawMediaNotificationListenerService.invokeNotificationActionAtVersion(key, actionIndex, expectedPostTime));
}
