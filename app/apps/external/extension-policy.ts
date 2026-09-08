/** Pure checks for the second boundary after authenticated native IPC. */
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function boundedToken(value: unknown, maximum = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9_.:-]+$/.test(value);
}
export type ToolCall = { callId: string; name: string; arguments: Record<string, unknown>; issuedAt: number; expiresAt: number };
export class ExtensionToolCalls {
  private readonly seen = new Map<string, number>();
  admit(owner: string, value: unknown, now = Date.now()): value is ToolCall {
    for (const [key, expiry] of this.seen) if (expiry < now) this.seen.delete(key);
    if (!record(value) || !boundedToken(value.callId) || !boundedToken(value.name, 256) || !record(value.arguments) ||
      typeof value.issuedAt !== "number" || !Number.isFinite(value.issuedAt) || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) ||
      value.issuedAt > now + 5000 || value.expiresAt < now || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 120000 ||
      JSON.stringify(value.arguments).length > 16384 || this.seen.has(`${owner}\n${value.callId}`) || this.seen.size >= 512) return false;
    this.seen.set(`${owner}\n${value.callId}`, value.expiresAt);
    return true;
  }
}
export type NotificationSource = { key: string; postTime: number };
/** Opaque IDs reveal neither native notification keys nor another APK's reply tokens. */
export class NotificationLeases<T extends NotificationSource> {
  private entries = new Map<string, { source: T; owner: string; generation: number }>();
  constructor(private readonly id: () => string) {}
  update(owner: string, generation: number, sources: T[]): { id: string; source: T }[] {
    const next = new Map<string, { source: T; owner: string; generation: number }>();
    const result: { id: string; source: T }[] = [];
    for (const source of sources.slice(0, 128)) {
      const previous = [...this.entries.entries()].find(([, entry]) => entry.owner === owner && entry.generation === generation && entry.source.key === source.key && entry.source.postTime === source.postTime);
      const id = previous?.[0] ?? `${source.key.startsWith("apk:") ? "apk:" : ""}${this.id()}`; next.set(id, { source, owner, generation }); result.push({ id, source });
    }
    this.entries = next;
    return result;
  }
  resolve(owner: string, generation: number, id: unknown, version: unknown, current: T[], nativeOnly = false): T | undefined {
    if (typeof id !== "string" || typeof version !== "number" || !Number.isSafeInteger(version)) return undefined;
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner || entry.generation !== generation || entry.source.postTime !== version || (nativeOnly && entry.source.key.startsWith("apk:"))) return undefined;
    return current.find(source => source.key === entry.source.key && source.postTime === version);
  }
  clear(): void { this.entries.clear(); }
}
