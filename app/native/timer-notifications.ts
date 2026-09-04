import { Utils } from "@nativescript/core";

declare const com: any;

/**
 * Bridge to FaceclawTimerNotifications.java: the durable Android alarm and
 * phone notification behind every Timers-app expiry (countdown timers and
 * alarms alike, keyed by the item's id). The phone posts the notification at
 * `triggerAtMs` even if the app process is asleep or gone.
 */

function getContext(): android.content.Context | null {
  if (!global.isAndroid) return null;
  return Utils.android.getApplicationContext() ?? null;
}

/** Schedule (or move) the Android alarm that posts `title` / `text` at triggerAtMs. */
export function scheduleTimerNotification(itemId: number, triggerAtMs: number, title: string, text: string): void {
  const context = getContext();
  if (!context) return;
  com.faceclaw.app.FaceclawTimerNotifications.schedule(context, itemId, triggerAtMs, title, text);
}

/** Cancel both a pending alarm and any already-posted notification. */
export function cancelTimerNotification(itemId: number): void {
  const context = getContext();
  if (!context) return;
  com.faceclaw.app.FaceclawTimerNotifications.cancel(context, itemId);
}

/** The engine's own expiry path; Java deduplicates it against the alarm's. */
export function fireTimerNotification(itemId: number, title: string, text: string): void {
  const context = getContext();
  if (!context) return;
  com.faceclaw.app.FaceclawTimerNotifications.fireNow(context, itemId, title, text);
}
