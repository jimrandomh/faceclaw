import { iosNotificationState, iosNotificationMessage } from './notification-icons.ios'
export function isNotificationListenerEnabled(): boolean { return iosNotificationState() === 'ready' }
export function requestNotificationListenerAccess(): void { /* iOS exposes no deep link to this Bluetooth setting. */ }
export function notificationEmptyMessage(): string { return iosNotificationMessage() }
