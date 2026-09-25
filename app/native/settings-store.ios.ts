declare const FaceclawSettings: any
const native = FaceclawSettings.shared()
const storage = {
  getString: (key: string, fallback: string): string => String(native.getStringFallback(key, fallback)),
  setString: (key: string, value: string): void => native.setStringValue(key, value),
  getBoolean: (key: string, fallback: boolean): boolean => Boolean(native.getBooleanFallback(key, fallback)),
  setBoolean: (key: string, value: boolean): void => native.setBooleanValue(key, value),
}

// The native JSONC store is shared by all isolates. Each isolate polls
// just its observed keys so callbacks always execute on the owning JS thread.
let lastToken = String(native.changeToken())
const observed = new Map<string, { read: () => string; value: string }>()
function observe(key: string, read: () => string): void {
  if (!observed.has(key)) observed.set(key, { read, value: read() })
}
function markChanged(key: string): void {
  const item = observed.get(key)
  if (item) item.value = item.read()
  changed(key)
}
let pollTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<(key: string) => void>()
export function disposeSettingsStore(): void {
  listeners.clear()
  if (pollTimer !== null) clearInterval(pollTimer)
  pollTimer = null
  observed.clear()
}
function changed(key: string): void {
  setTimeout(() => { for (const listener of [...listeners]) listener(key) }, 0)
}
export function getStringSetting(key: string, fallback: string): string {
  const value = storage.getString(key, fallback)
  observe(key, () => JSON.stringify(storage.getString(key, fallback)))
  return value
}
export function setStringSetting(key: string, value: string): void {
  getStringSetting(key, '')
  const before = String(native.changeToken())
  storage.setString(key, value)
  if (String(native.changeToken()) !== before) markChanged(key)
}
export function getBooleanSetting(key: string, fallback: boolean): boolean {
  const value = storage.getBoolean(key, fallback)
  observe(key, () => JSON.stringify(storage.getBoolean(key, fallback)))
  return value
}
export function setBooleanSetting(key: string, value: boolean): void {
  getBooleanSetting(key, false)
  const before = String(native.changeToken())
  storage.setBoolean(key, value)
  if (String(native.changeToken()) !== before) markChanged(key)
}
export function onSettingsStoreChanged(listener: (key: string) => void): () => void {
  listeners.add(listener)
  if (!pollTimer) pollTimer = setInterval(() => {
    const token = String(native.changeToken())
    if (token === lastToken) return
    lastToken = token
    for (const [key, item] of observed) {
      const value = item.read()
      if (value !== item.value) { item.value = value; changed(key) }
    }
  }, 250)
  return () => { listeners.delete(listener); if (!listeners.size && pollTimer) { clearInterval(pollTimer); pollTimer = null } }
}

export function getNumberSetting(key: string, fallback: number): number {
  const read = () => Number(native.getNumberFallback(key, fallback))
  observe(key, () => JSON.stringify(read()))
  return read()
}
export function setNumberSetting(key: string, value: number): void { getNumberSetting(key, 0); native.setNumberValue(key, value); markChanged(key) }
export function removeSetting(key: string): void { native.remove(key); markChanged(key) }
