import type { AndroidNotification } from "./notification-types";

export type ExternalNotification = AndroidNotification & { component: string; target: string; id: string; expiresAt: number; replyToken?: string; replyConsumed?: boolean };
const entries = new Map<string, ExternalNotification>();
export type NotificationReplyStatus = "sent" | "draft-saved" | "unknown" | "rejected";
type PendingReply = { entry: ExternalNotification; until: number; result: (status: NotificationReplyStatus) => void };
const pendingReplies = new Map<string, PendingReply>();
const replyKey = (component: string, id: string, token: string) => JSON.stringify([component, id, token]);
function finishReply(key: string, status: NotificationReplyStatus): void {
  const pending = pendingReplies.get(key); if (!pending) return;
  pendingReplies.delete(key); try { pending.result(status); } catch { /* Isolate a stale UI callback. */ }
}
export function acceptExternalNotificationReplyResult(component: string, data: any): void {
  if (!data || !["sent", "draft-saved", "unknown", "rejected"].includes(data.status) || typeof data.id !== "string" || typeof data.replyToken !== "string") return;
  externalNotifications();
  const key = replyKey(component, data.id, data.replyToken), pending = pendingReplies.get(key);
  if (pending && entries.get(pending.entry.key) === pending.entry && canReply(component)) finishReply(key, data.status);
}
let replyEpoch = 0;
export function invalidateExternalNotificationReplies(): void {
  replyEpoch++;
  for (const key of [...pendingReplies.keys()]) finishReply(key, "rejected");
}
let lastVersion = 0;
let suppressed = new Set<string>();
let permittedSource: (packageName: string) => boolean = () => true;
/** Each host may narrow presentation using its existing notification preferences. */
export function setExternalNotificationPolicy(policy: typeof permittedSource): void { permittedSource = policy; }
let onOpen: (component: string, target: string) => void = () => {};
let canReply: (component: string) => boolean = () => false;
let sendReply: (component: string, data: unknown) => boolean = () => false;
export function configureExternalNotificationReplies(allowed: typeof canReply, send: typeof sendReply): void { canReply = allowed; sendReply = send; }
let onChange: (key: string) => void = () => {};
export function configureExternalNotifications(open: typeof onOpen, change: typeof onChange): void { onOpen = open; onChange = change; }
export function setSuppressedNotificationPackages(packages: string[]): void { suppressed = new Set(packages); }
export function isNotificationPackageSuppressed(packageName: string): boolean { return suppressed.has(packageName); }
export function externalNotifications(now = Date.now()): ExternalNotification[] {
  for (const [key, value] of entries) if (value.expiresAt <= now) entries.delete(key);
  for (const [key, pending] of pendingReplies) {
    if (entries.get(pending.entry.key) !== pending.entry || !canReply(pending.entry.component) || !permittedSource(pending.entry.packageName)) finishReply(key, "rejected");
    else if (pending.until <= now) finishReply(key, "unknown");
  }
  return [...entries.values()].filter(entry => permittedSource(entry.packageName)).sort((a, b) => b.postTime - a.postTime);
}
export function putExternalNotification(component: string, appName: string, data: any, previews: boolean, now = Date.now()): string | null {
  if (!data || typeof data.id !== "string" || !data.id || data.id.length > 128 || typeof data.target !== "string" || !data.target || data.target.length > 512) return null;
  if (typeof data.title !== "string" || data.title.length > 160 || typeof data.text !== "string" || data.text.length > 4096) return null;
  const expiresAt = Math.min(Number(data.expiresAt) || now + 30 * 86400000, now + 30 * 86400000);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  const key = `apk:${component}:${data.id}`;
  externalNotifications(now);
  const own = [...entries.values()].filter((entry) => entry.component === component);
  if (!entries.has(key) && (own.length >= 32 || entries.size >= 128)) return null;
  const replyToken = typeof data.replyToken === "string" && data.replyToken.length > 0 && data.replyToken.length <= 128 ? data.replyToken : undefined;
  const body = previews ? data.text : "New message";
  const previous = entries.get(key);
  if (previous && previous.target === data.target && previous.title === data.title && previous.text === body && previous.expiresAt === expiresAt && previous.replyToken === replyToken) return key;
  const version = lastVersion = Math.max(now, lastVersion + 1);
  entries.set(key, { key, component, id: data.id, target: data.target, expiresAt, replyToken, replyConsumed: previous?.replyToken === replyToken && previous?.replyConsumed,
    packageName: component.split("/")[0]!, appName,
    title: data.title, text: body, bigText: "", subText: "", infoText: "", summaryText: "", category: "msg", lines: [], postTime: version, when: now,
    actions: [{ index: 0, title: "Open conversation", enabled: true, acceptsText: false }, ...(replyToken ? [{ index: 1, title: "Reply", enabled: true, acceptsText: true }] : [])],
  });
  return key;
}
export function clearExternalNotifications(component: string): void {
  for (const [key, value] of entries) if (value.component === component) entries.delete(key);
  externalNotifications(); onChange("");
}
export function removeExternalNotification(component: string, id: string): void { if (entries.delete(`apk:${component}:${id}`)) { externalNotifications(); onChange(""); } }
export function dismissExternalNotification(key: string, expectedPostTime?: number): boolean {
  const entry = externalNotifications().find(item => item.key === key);
  if (!entry || (expectedPostTime !== undefined && entry.postTime !== expectedPostTime)) return false;
  const removed = entries.delete(key); if (removed) onChange(""); return removed; }
export function hasExternalNotification(key: string): boolean { externalNotifications(); return entries.has(key); }
export function invokeExternalNotification(key: string, index: number, expectedPostTime?: number): boolean {
  const entry = externalNotifications().find((item) => item.key === key);
  if (!entry || index !== 0 || (expectedPostTime !== undefined && entry.postTime !== expectedPostTime)) return false;
  entries.delete(key); onChange(""); onOpen(entry.component, entry.target); return true;
}

/** UI-only, version-bound destination. Never delegates APK replies to Android RemoteInput. */
export function getExternalNotificationReply(key: string, version: number): { isCurrent: () => boolean; send: (text: string, result?: (status: NotificationReplyStatus) => void) => boolean } | undefined {
  const entry = externalNotifications().find(item => item.key === key && item.postTime === version);
  if (!entry?.replyToken || entry.replyConsumed || !canReply(entry.component)) return undefined;
  const epoch = replyEpoch;
  const isCurrent = () => epoch === replyEpoch && externalNotifications().includes(entry) && !entry.replyConsumed && canReply(entry.component);
  return { isCurrent, send: (text, result = () => {}) => {
    if (typeof text !== "string" || !text.trim() || text.length > 8000 || !isCurrent()) return false;
    entry.replyConsumed = true;
    const key = replyKey(entry.component, entry.id, entry.replyToken!);
    pendingReplies.set(key, { entry, until: Date.now() + 20000, result });
    let submitted = false;
    try { submitted = sendReply(entry.component, { id: entry.id, target: entry.target, replyToken: entry.replyToken, text, confirmed: true }); }
    catch { /* Uncertain dispatch is never retried automatically. */ }
    if (!submitted) pendingReplies.delete(key);
    return submitted;
  } };
}
