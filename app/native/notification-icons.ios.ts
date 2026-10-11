import { GrayImage } from '../graphics/image'
import { renderIcon, type IconName } from '../graphics/icons'
import { AncsClient, ANCS_CONNECT_MESSAGE, type AncsState } from '../g2/ancs-client'
import { rememberNotificationSources } from './notification-sources'
import type { AndroidNotification } from './notification-types'
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
// ANCS does not provide app icons, so show one for the notification's ANCS
// category; never fetch notification sources or content from a third-party
// icon service. Indexed by CategoryID: Other, IncomingCall, MissedCall,
// Voicemail, Social, Schedule, Email, News, HealthAndFitness,
// BusinessAndFinance, Location, Entertainment.
const CATEGORY_ICONS: readonly IconName[] = ['bell','phone-incoming','phone-missed','voicemail','message-circle',
  'calendar','mail','newspaper','heart-pulse','briefcase','map-pin','tv']
function categoryIcon(category: string): GrayImage {
  return renderIcon(CATEGORY_ICONS[Number(category)] ?? 'bell',24)?.clone() ?? bell()
}
// Drawn fallback for when the SVG rasterizer fails.
function bell(): GrayImage {
  const image = new GrayImage(24,24,0)
  image.fillRoundedRect(6,5,12,13,220,5)
  image.fillRect(4,17,16,2,220)
  image.fillRect(10,20,4,2,220)
  return image
}
export function readActiveNotificationIcons(maxIcons: number, _allowStale: boolean) {
  // One icon per source, standing for its first notification.
  const sources = new Map<string, AndroidNotification>()
  for (const n of readActiveNotifications(ALL_NOTIFICATIONS)) if (!sources.has(n.packageName)) sources.set(n.packageName, n)
  const shown = Array.from(sources.values()).slice(0,Math.max(0,maxIcons))
  return {icons: shown.map(n => categoryIcon(n.category)),keys: shown.map(n => n.key),stale:false}
}
export function readNotificationIconByKey(key: string, _allowStale: boolean) {
  const notification = readActiveNotifications(ALL_NOTIFICATIONS).find(n => n.key === key)
  return {icon: notification ? categoryIcon(notification.category) : null,stale:false}
}
