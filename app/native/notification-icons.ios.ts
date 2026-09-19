import { GrayImage } from '../graphics/image'
import { AncsClient, ANCS_CONNECT_MESSAGE, type AncsState } from '../g2/ancs-client'
import { rememberNotificationSources } from './notification-sources'
export type { AndroidNotification, AndroidNotificationAction } from './notification-types'
export type { NotificationIconsResult, NotificationIconResult } from './notification-icons'

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
// ANCS does not provide app icons. Use a local bell; never fetch notification
// sources or content from a third-party icon service.
function bell(): GrayImage {
  const image = new GrayImage(24,24,0)
  image.fillRoundedRect(6,5,12,13,220,5)
  image.fillRect(4,17,16,2,220)
  image.fillRect(10,20,4,2,220)
  return image
}
export function readActiveNotificationIcons(maxIcons: number, _allowStale: boolean) {
  const sources = new Set(readActiveNotifications(ALL_NOTIFICATIONS).map(n => n.packageName))
  return {icons: Array.from(sources).slice(0,Math.max(0,maxIcons)).map(() => bell()),stale:false}
}
export function readNotificationIconByKey(key: string, _allowStale: boolean) {
  return {icon: readActiveNotifications(ALL_NOTIFICATIONS).some(n => n.key === key) ? bell() : null,stale:false}
}
