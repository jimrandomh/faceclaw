import { GrayImage } from "../graphics/image";
import { logCurrent, spanCurrent } from "./frame-timings";
import { toUint8Array } from "../util/array-util";
import { rememberNotificationSources } from "./notification-sources";
import { PHOTO_TONE, grayImageFromPacket } from "./image-files";

declare const com: any;
declare const java: any;

const ICON_SIZE = 24;
/** Ask the native listener for every active source, including those below the list's display limit. */
export const ALL_NOTIFICATIONS = 0x7fffffff;
// Backstop TTL only: the icon caches are invalidated eagerly whenever a
// notification is posted or removed (see invalidateIconCaches callers), so
// the tray is kept fresh by invalidation, not by expiry. A short TTL just
// forced a blocking main-thread re-fetch (~40-100ms of Java icon
// rasterization) every few seconds — usually producing a no-change frame that
// was then discarded. A long backstop keeps that off the render hot path.
const ICON_CACHE_MS = 60_000;

let cachedIcons: GrayImage[] = [];
let cachedKeys: string[] = [];
let cachedAtMs = 0;
const keyedIconCache = new Map<string, { icon: GrayImage | null; atMs: number }>();
const KEYED_ICON_CACHE_MAX = 128;
/** Pictures are the size of a detail view, not 24px icons: keep just the recently viewed few. */
const pictureCache = new Map<string, {
  postTime: number; maxWidth: number; maxHeight: number; picture: GrayImage | null; atMs: number;
}>();
const PICTURE_CACHE_MAX = 8;
let notificationListenerProxy: any = null;
const notificationPostedListeners = new Set<(notificationKey: string) => void>();
const notificationRemovedListeners = new Set<(notificationKey: string) => void>();
let listenerStateObserver: any = null;
const listenerStateListeners = new Set<() => void>();

function invalidateIconCaches(): void {
  cachedAtMs = 0;
  keyedIconCache.clear();
}

import type { AndroidNotification, AndroidNotificationAction } from "./notification-types";
export type { AndroidNotification, AndroidNotificationAction } from "./notification-types";

export type NotificationIconsResult = {
  icons: GrayImage[];
  /**
   * The notification each icon stands for, by key, in step with icons: the
   * member of its group (which gets one icon) the icon was taken from.
   */
  keys: string[];
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
  if (!global.isAndroid || maxIcons <= 0) return { icons: [], keys: [], stale: false };

  const now = Date.now();
  if (cachedAtMs > 0 && now - cachedAtMs < ICON_CACHE_MS) {
    logCurrent("notification icons served from cache");
    return cachedIconsResult(maxIcons, false);
  }
  if (allowStale) {
    logCurrent("notification icons served stale");
    return cachedIconsResult(maxIcons, true);
  }

  // Every icon, whatever this caller wants: the cache serves callers asking
  // for different counts (the switcher row needs them all to lay itself out).
  const keyList = new java.util.ArrayList();
  const bytes = spanCurrent("fetch-notification-icons", () =>
    toUint8Array(
      com.faceclaw.app.FaceclawMediaNotificationListenerService.getActiveNotificationIconGrays(
        ICON_SIZE,
        ALL_NOTIFICATIONS,
        keyList,
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
  const keys: string[] = [];
  for (let index = 0; index < iconCount; index++) {
    keys.push(index < keyList.size() ? String(keyList.get(index)) : "");
  }

  cachedIcons = icons;
  cachedKeys = keys;
  cachedAtMs = now;
  return cachedIconsResult(maxIcons, false);
}

/** Copies of the first maxIcons cached icons, with their keys. */
function cachedIconsResult(maxIcons: number, stale: boolean): NotificationIconsResult {
  return { icons: cachedIcons.slice(0, maxIcons).map(icon => icon.clone()), keys: cachedKeys.slice(0, maxIcons), stale };
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

export type NotificationPictureResult = {
  /** Shared with the cache: blit it, don't draw on it. */
  picture: GrayImage | null;
  /** True when allowStale served an earlier fetch (or nothing) in place of a fetch for these arguments. */
  stale: boolean;
};

/**
 * The picture attached to a notification (hasPicture), scaled to fit
 * maxWidth x maxHeight with the photo tone and inverted if it is drawn on a
 * light background (GrayPacket.hasLightBackground), under the allow-stale contract of
 * readNotificationIconByKey. Cached per post of the notification: an ongoing
 * notification updated in place (Dexcom redraws its graph every few minutes)
 * fires no posted event, but its postTime moves. ICON_CACHE_MS is the
 * backstop here too. Under allowStale an earlier fetch stands in, if it fits.
 */
export function readNotificationPicture(
  notification: AndroidNotification,
  maxWidth: number,
  maxHeight: number,
  allowStale: boolean,
): NotificationPictureResult {
  const width = Math.round(maxWidth);
  const height = Math.round(maxHeight);
  if (!global.isAndroid || !notification.hasPicture || width <= 0 || height <= 0) {
    return { picture: null, stale: false };
  }

  const now = Date.now();
  const cached = pictureCache.get(notification.key);
  if (
    cached && cached.postTime === notification.postTime && cached.maxWidth === width
    && cached.maxHeight === height && now - cached.atMs < ICON_CACHE_MS
  ) {
    return { picture: cached.picture, stale: false };
  }
  if (allowStale) {
    const fits = cached?.picture && cached.picture.width <= width && cached.picture.height <= height;
    return { picture: fits ? cached!.picture : null, stale: true };
  }

  const picture = spanCurrent("fetch-notification-picture", () =>
    grayImageFromPacket(
      com.faceclaw.app.FaceclawMediaNotificationListenerService.getNotificationPictureGray(
        notification.key,
        width,
        height,
        PHOTO_TONE.gamma,
        PHOTO_TONE.dither,
        // A chart or screenshot made for a light theme would be a glaring
        // lit panel on the glasses: show it light-on-dark.
        true,
      ),
    ),
  );
  pictureCache.delete(notification.key);
  pictureCache.set(notification.key, { postTime: notification.postTime, maxWidth: width, maxHeight: height, picture, atMs: now });
  while (pictureCache.size > PICTURE_CACHE_MAX) {
    const oldestKey = pictureCache.keys().next().value;
    if (oldestKey === undefined) break;
    pictureCache.delete(oldestKey);
  }
  return { picture, stale: false };
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
  return addNotificationListener(notificationPostedListeners, listener);
}

/**
 * A listed notification went away: cancelled by its source (including one
 * withdrawn moments after it was posted), dismissed on the phone or from the
 * glasses, or updated into one the glasses don't list.
 */
export function onAndroidNotificationRemoved(listener: (notificationKey: string) => void): () => void {
  return addNotificationListener(notificationRemovedListeners, listener);
}

/**
 * Any change to the listed notifications (a post, a removal, or the listener
 * connecting or going missing), for views that just repaint.
 */
export function onAndroidNotificationsChanged(listener: () => void): () => void {
  const offPosted = onAndroidNotificationPosted(listener);
  const offRemoved = onAndroidNotificationRemoved(listener);
  const offState = onListenerStateChanged(listener);
  return () => {
    offPosted();
    offRemoved();
    offState();
  };
}

function onListenerStateChanged(listener: () => void): () => void {
  listenerStateListeners.add(listener);
  if (global.isAndroid && !listenerStateObserver) {
    listenerStateObserver = new java.lang.Runnable({
      run: () => {
        invalidateIconCaches();
        const snapshot = Array.from(listenerStateListeners);
        setTimeout(() => {
          for (const each of snapshot) {
            each();
          }
        }, 0);
      },
    });
    com.faceclaw.app.FaceclawMediaNotificationListenerService.addListenerStateObserver(listenerStateObserver);
  }
  return () => {
    listenerStateListeners.delete(listener);
    if (listenerStateListeners.size === 0 && listenerStateObserver) {
      com.faceclaw.app.FaceclawMediaNotificationListenerService.removeListenerStateObserver(listenerStateObserver);
      listenerStateObserver = null;
    }
  };
}

function addNotificationListener(
  listeners: Set<(notificationKey: string) => void>,
  listener: (notificationKey: string) => void,
): () => void {
  listeners.add(listener);
  ensureNativeNotificationListener();
  return () => {
    listeners.delete(listener);
    if (notificationPostedListeners.size === 0 && notificationRemovedListeners.size === 0) {
      removeNativeNotificationListener();
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
    foregroundService: Boolean(value.foregroundService),
    hasPicture: Boolean(value.hasPicture),
  };
}

function ensureNativeNotificationListener(): void {
  if (!global.isAndroid || notificationListenerProxy) return;
  notificationListenerProxy = new com.faceclaw.app.FaceclawNotificationListener({
    onNotificationPosted: (notificationKey: string) => {
      dispatchNotificationEvent(notificationPostedListeners, notificationKey);
    },
    onNotificationRemoved: (notificationKey: string) => {
      dispatchNotificationEvent(notificationRemovedListeners, notificationKey);
    },
  });
  com.faceclaw.app.FaceclawMediaNotificationListenerService.addNotificationListener(
    notificationListenerProxy,
  );
}

function dispatchNotificationEvent(listeners: Set<(notificationKey: string) => void>, notificationKey: string): void {
  invalidateIconCaches();
  const key = String(notificationKey);
  const snapshot = Array.from(listeners);
  setTimeout(() => {
    for (const listener of snapshot) {
      listener(key);
    }
  }, 0);
}

function removeNativeNotificationListener(): void {
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
