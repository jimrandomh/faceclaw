/**
 * A worker's view of the settings: the snapshot it booted with, kept current by
 * the main thread's broadcasts. Reads are synchronous, as app code expects.
 */
declare const self: any;

const values = new Map<string, string>(Object.entries((self.__faceclawBoot?.settings ?? {}) as Record<string, string>));
const listeners = new Set<(key: string) => void>();

function changed(key: string): void {
  setTimeout(() => { for (const listener of [...listeners]) listener(key); }, 0);
}

// Registered before the app sets onmessage, so it runs first and the app never sees these.
self.addEventListener("message", (event: MessageEvent) => {
  if (event.data?.type !== "__setting-changed") return;
  event.stopImmediatePropagation();
  values.set(event.data.key, event.data.value);
  changed(event.data.key);
});

export function disposeSettingsStore(): void {
  listeners.clear();
}

export function getStringSetting(key: string, defaultValue: string): string {
  return values.get(key) ?? defaultValue;
}

export function setStringSetting(key: string, value: string): void {
  const text = String(value);
  if (values.get(key) === text) return;
  values.set(key, text);
  self.postMessage({ type: "__setting-set", key, value: text });
  changed(key);
}

export function getBooleanSetting(key: string, defaultValue: boolean): boolean {
  const raw = values.get(key);
  return raw === undefined ? defaultValue : raw === "true";
}

export function setBooleanSetting(key: string, value: boolean): void {
  setStringSetting(key, String(Boolean(value)));
}

export function onSettingsStoreChanged(listener: (key: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
