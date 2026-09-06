import { ApplicationSettings } from '@nativescript/core'

// Main-isolate settings for the initial iOS port. Worker synchronization will
// be added when worker-hosted apps are enabled on iOS.
const listeners = new Set<(key: string) => void>()
function changed(key: string): void {
  setTimeout(() => { for (const listener of [...listeners]) listener(key) }, 0)
}
export function getStringSetting(key: string, fallback: string): string {
  return ApplicationSettings.getString(key, fallback)
}
export function setStringSetting(key: string, value: string): void {
  if (getStringSetting(key, '') === value && ApplicationSettings.hasKey(key)) return
  ApplicationSettings.setString(key, value)
  changed(key)
}
export function getBooleanSetting(key: string, fallback: boolean): boolean {
  return ApplicationSettings.getBoolean(key, fallback)
}
export function setBooleanSetting(key: string, value: boolean): void {
  if (getBooleanSetting(key, false) === value && ApplicationSettings.hasKey(key)) return
  ApplicationSettings.setBoolean(key, value)
  changed(key)
}
export function onSettingsStoreChanged(listener: (key: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
