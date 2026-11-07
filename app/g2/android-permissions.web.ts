/** A browser demo asks for nothing: its "sensors" and "accounts" are sample data. */
export async function ensureBlePermissions(): Promise<void> {}
export async function ensureVoicePermissions(): Promise<void> {}
export function hasBlePermissions(): boolean { return true; }
export async function requestBlePermissions(): Promise<boolean> { return true; }
export function hasPostNotificationsPermission(): boolean { return true; }
export async function requestPostNotificationsPermission(): Promise<boolean> { return true; }
export function hasMicrophonePermission(): boolean { return false; }
export async function requestMicrophonePermission(): Promise<boolean> { return false; }
export function hasCalendarPermission(): boolean { return true; }
export async function ensureCalendarPermission(): Promise<boolean> { return true; }
export function hasFineLocationPermission(): boolean { return true; }
export async function ensureFineLocationPermission(): Promise<boolean> { return true; }
export function hasLocationPermission(): boolean { return true; }
export async function ensureLocationPermission(): Promise<boolean> { return true; }
