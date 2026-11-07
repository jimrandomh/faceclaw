/**
 * Browser settings: localStorage on the main thread, the source of truth for
 * every context. Workers keep a snapshot and forward their writes (see
 * settings-store.webworker.ts and app/web/workers.ts).
 */
import { broadcastSettingToWorkers } from "../web/workers";

const PREFIX = "faceclaw.setting.";
const listeners = new Set<(key: string) => void>();

function storage(): Storage | null {
  try { return localStorage; } catch { return null; }
}

// Private windows can refuse localStorage; settings then last until the page reloads.
const fallback = new Map<string, string>();

function read(key: string): string | null {
  const stored = storage()?.getItem(PREFIX + key);
  return stored ?? fallback.get(key) ?? null;
}

function write(key: string, value: string): void {
  try {
    const local = storage();
    if (!local) throw new Error("no localStorage");
    local.setItem(PREFIX + key, value);
  } catch {
    fallback.set(key, value);
  }
}

function changed(key: string): void {
  // One message-loop tick later, as the native stores notify.
  setTimeout(() => { for (const listener of [...listeners]) listener(key); }, 0);
}

/** A write from a worker (already applied there). */
export function applyWorkerSetting(key: string, value: string, from: unknown): void {
  write(key, value);
  broadcastSettingToWorkers(key, value, from);
  changed(key);
}

/** Every stored setting, as the initial snapshot for a new worker. */
export function settingsSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = Object.fromEntries(fallback);
  const local = storage();
  if (local) {
    for (let i = 0; i < local.length; i++) {
      const key = local.key(i);
      if (key?.startsWith(PREFIX)) snapshot[key.slice(PREFIX.length)] = local.getItem(key) ?? "";
    }
  }
  return snapshot;
}

/** Forget everything (the page's "Reset demo"). */
export function clearSettings(): void {
  fallback.clear();
  const local = storage();
  if (!local) return;
  for (let i = local.length - 1; i >= 0; i--) {
    const key = local.key(i);
    if (key?.startsWith(PREFIX)) local.removeItem(key);
  }
}

export function disposeSettingsStore(): void {
  listeners.clear();
}

export function getStringSetting(key: string, defaultValue: string): string {
  return read(key) ?? defaultValue;
}

export function setStringSetting(key: string, value: string): void {
  const text = String(value);
  if (read(key) === text) return;
  write(key, text);
  broadcastSettingToWorkers(key, text, null);
  changed(key);
}

export function getBooleanSetting(key: string, defaultValue: boolean): boolean {
  const raw = read(key);
  return raw === null ? defaultValue : raw === "true";
}

export function setBooleanSetting(key: string, value: boolean): void {
  setStringSetting(key, String(Boolean(value)));
}

export function onSettingsStoreChanged(listener: (key: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
