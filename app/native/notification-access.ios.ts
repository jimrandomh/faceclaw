import { iosNotificationState, iosNotificationMessage } from './notification-icons.ios'
export function isNotificationListenerEnabled(): boolean { return iosNotificationState() === 'ready' }
export function requestNotificationListenerAccess(): void { /* iOS exposes no deep link to this Bluetooth setting. */ }
export function notificationEmptyMessage(): string { return iosNotificationMessage() }
export type NotificationListenerState = "connected" | "no-access" | "connecting" | "stuck"
export function notificationListenerState(): NotificationListenerState { return isNotificationListenerEnabled() ? "connected" : "no-access" }
export function watchNotificationListenerBinding(): void { /* ANCS has no listener binding to watch. */ }
