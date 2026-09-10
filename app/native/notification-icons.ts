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
const notificationPostedListeners = new Set<(notificationKey: string) => void>();

function invalidateIconCaches(): void {
  cachedAtMs = 0;
  keyedIconCache.clear();
}

export type AndroidNotificationAction = {
  index: number;
  title: string;
  enabled: boolean;
};

export type AndroidNotification = {
  key: string;
  packageName: string;
  appName: string;
  title: string;
  text: string;
  bigText: string;
  subText: string;
  infoText: string;
  summaryText: string;
  category: string;
  lines: string[];
  postTime: number;
  when: number;
  actions: AndroidNotificationAction[];
};

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

  const now = Date.now();
  if (cachedAtMs > 0 && now - cachedAtMs < ICON_CACHE_MS) {
    logCurrent("notification icons served from cache");
    return { icons: cachedIcons.map(icon => icon.clone()), stale: false };
  }
  if (allowStale) {
    logCurrent("notification icons served stale");
    return { icons: cachedIcons.map(icon => icon.clone()), stale: true };
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
  return { icons: icons.map(icon => icon.clone()), stale: false };
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

export function readActiveNotifications(maxNotifications = 50): AndroidNotification[] {
  if (!global.isAndroid || maxNotifications <= 0) return [];
  try {
    const json = spanCurrent("fetch-notifications-json", () =>
      String(
        com.faceclaw.app.FaceclawMediaNotificationListenerService.getActiveNotificationsJson(
          Math.max(0, Math.round(maxNotifications)),
        ),
      ),
    );
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const notifications = parsed.map(normalizeNotification).filter((item): item is AndroidNotification => Boolean(item));
    rememberNotificationSources(notifications);
    return notifications;
  } catch {
    return [];
  }
}

export function invokeNotificationAction(notificationKey: string, actionIndex: number): boolean {
  if (!global.isAndroid || !notificationKey) return false;
  invalidateIconCaches();
  return Boolean(
    com.faceclaw.app.FaceclawMediaNotificationListenerService.invokeNotificationAction(
      notificationKey,
      Math.round(actionIndex),
    ),
  );
}

export function dismissNotification(notificationKey: string): boolean {
  if (!global.isAndroid || !notificationKey) return false;
  invalidateIconCaches();
  return Boolean(
    com.faceclaw.app.FaceclawMediaNotificationListenerService.dismissNotification(notificationKey),
  );
}

export function onAndroidNotificationPosted(listener: (notificationKey: string) => void): () => void {
  notificationPostedListeners.add(listener);
  ensureNotificationPostedListener();
  return () => {
    notificationPostedListeners.delete(listener);
    if (notificationPostedListeners.size === 0) {
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
    lines: Array.isArray(value.lines) ? value.lines.map((line: unknown) => String(line)).filter(Boolean) : [],
    postTime: Number(value.postTime) || 0,
    when: Number(value.when) || 0,
    actions,
  };
}

function ensureNotificationPostedListener(): void {
  if (!global.isAndroid || notificationListenerProxy) return;
  notificationListenerProxy = new com.faceclaw.app.FaceclawNotificationListener({
    onNotificationPosted: (notificationKey: string) => {
      invalidateIconCaches();
      const key = String(notificationKey);
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
  };
}
