import type { GrayImage } from '../graphics/image'
import { pebbleIcon } from '../graphics/pebble-icons'
import { AncsClient, ANCS_CONNECT_MESSAGE, type AncsState } from '../g2/ancs-client'
import { notificationAppIcon, notificationCategoryIcon } from './notification-app-icons'
import { rememberNotificationSources } from './notification-sources'
import type { AndroidNotification } from './notification-types'
export type { AndroidNotification, AndroidNotificationAction } from './notification-types'
export type { NotificationIconsResult, NotificationIconResult, NotificationImageResult } from './notification-icons'

export const ALL_NOTIFICATIONS = 0x7fffffff
let active: AncsClient | null = null
const listeners = new Set<(key: string) => void>()
const popups = new Set<(key: string) => void>()
export function bindIosNotifications(client: AncsClient): void { active = client }
export function iosNotificationsChanged(key?: string, popup = false): void {
  const current = active
  if (current) rememberNotificationSources(current.read(ALL_NOTIFICATIONS))
  for (const listener of listeners) listener(key ?? '')
  if (popup && key) for (const listener of popups) listener(key)
}
export function onIosNotificationPopup(listener: (key: string) => void): () => void {
  popups.add(listener); return () => { popups.delete(listener) }
}
export function iosNotificationMessage(): string { return active?.statusMessage ?? ANCS_CONNECT_MESSAGE }
export function iosNotificationState(): AncsState { return active?.state ?? 'disconnected' }
export function readActiveNotifications(maxNotifications = 50) { return active?.read(maxNotifications) ?? [] }
export function invokeNotificationAction(key: string, index: number): boolean { return active?.action(key,index) ?? false }
export function dismissNotification(key: string): boolean { return active?.dismiss(key) ?? false }
export function onAndroidNotificationPosted(listener: (key: string) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener) }
}
// ANCS removals carry no key and already reach the posted listeners above
// (they hear every change), and an open popup closes on the repaint that follows.
export function onAndroidNotificationRemoved(_listener: (key: string) => void): () => void { return () => {} }
export function onAndroidNotificationsChanged(listener: () => void): () => void { return onAndroidNotificationPosted(listener) }
// ANCS does not provide app icons, so show a bundled Pebble icon for the
// source app (by bundle ID or display name), else for the notification's
// ANCS category. Never fetch notification sources or content from a
// third-party icon service.
function notificationIcon(notification: AndroidNotification): GrayImage {
  const name = notificationAppIcon(notification.packageName, notification.appName) ?? notificationCategoryIcon(notification.category)
  return pebbleIcon(name).clone()
}
export function readActiveNotificationIcons(maxIcons: number, _allowStale: boolean) {
  // One icon per source, standing for its first notification.
  const sources = new Map<string, AndroidNotification>()
  for (const n of readActiveNotifications(ALL_NOTIFICATIONS)) if (!sources.has(n.packageName)) sources.set(n.packageName, n)
  const shown = Array.from(sources.values()).slice(0,Math.max(0,maxIcons))
  return {icons: shown.map(notificationIcon),keys: shown.map(n => n.key),stale:false}
}
export function readNotificationIconByKey(key: string, _allowStale: boolean) {
  const notification = readActiveNotifications(ALL_NOTIFICATIONS).find(n => n.key === key)
  return {icon: notification ? notificationIcon(notification) : null,stale:false}
}
// ANCS carries no attachments, avatars or custom layouts.
export function readNotificationPicture(_notification: AndroidNotification, _maxWidth: number, _maxHeight: number, _allowStale: boolean) {
  return {image: null,stale:false}
}
export function readNotificationLargeIcon(_notification: AndroidNotification, _size: number, _allowStale: boolean) {
  return {image: null,stale:false}
}
export function readNotificationCustomView(_notification: AndroidNotification, _maxWidth: number, _maxHeight: number, _allowStale: boolean) {
  return {image: null,stale:false}
}
