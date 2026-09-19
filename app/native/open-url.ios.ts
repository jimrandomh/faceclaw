import { Utils } from '@nativescript/core'
declare const global: any

export function openUrlOnPhone(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  if (NSThread.isMainThread) void Utils.openUrl(url)
  else global.postMessage({ type: 'open-url', url })
  return true
}
