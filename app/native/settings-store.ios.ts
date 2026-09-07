import { ApplicationSettings } from '@nativescript/core'

// NSUserDefaults is shared by all NativeScript isolates. Each isolate polls
// just its observed keys so callbacks always execute on the owning JS thread.
const CHANGE_TOKEN = 'ios.settings.changeToken'
let lastToken = ApplicationSettings.getString(CHANGE_TOKEN, '')
const observed = new Map<string, { read: () => string; value: string }>()
function observe(key: string, read: () => string): void {
  if (!observed.has(key)) observed.set(key, { read, value: read() })
}
function markChanged(key: string): void {
  // A unique token lets other isolates check one key while idle. It does not
  // depend on a read/increment/write counter that concurrent writers could lose.
  ApplicationSettings.setString(CHANGE_TOKEN, `${Date.now()}:${Math.random()}`)
  const item = observed.get(key)
  if (item) item.value = item.read()
  changed(key)
}
let pollTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<(key: string) => void>()
function changed(key: string): void {
  setTimeout(() => { for (const listener of [...listeners]) listener(key) }, 0)
}
export function getStringSetting(key: string, fallback: string): string {
  const value = ApplicationSettings.getString(key, fallback)
  observe(key, () => JSON.stringify(ApplicationSettings.getString(key, fallback)))
  return value
}
export function setStringSetting(key: string, value: string): void {
  if (getStringSetting(key, '') === value && ApplicationSettings.hasKey(key)) return
  ApplicationSettings.setString(key, value)
  markChanged(key)
}
export function getBooleanSetting(key: string, fallback: boolean): boolean {
  const value = ApplicationSettings.getBoolean(key, fallback)
  observe(key, () => JSON.stringify(ApplicationSettings.getBoolean(key, fallback)))
  return value
}
export function setBooleanSetting(key: string, value: boolean): void {
  if (getBooleanSetting(key, false) === value && ApplicationSettings.hasKey(key)) return
  ApplicationSettings.setBoolean(key, value)
  markChanged(key)
}
export function onSettingsStoreChanged(listener: (key: string) => void): () => void {
  listeners.add(listener)
  if (!pollTimer) pollTimer = setInterval(() => {
    const token = ApplicationSettings.getString(CHANGE_TOKEN, '')
    if (token === lastToken) return
    lastToken = token
    for (const [key, item] of observed) {
      const value = item.read()
      if (value !== item.value) { item.value = value; changed(key) }
    }
  }, 250)
  return () => { listeners.delete(listener); if (!listeners.size && pollTimer) { clearInterval(pollTimer); pollTimer = null } }
}
