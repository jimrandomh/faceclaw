export function hasCalendarPermission(): boolean { return true; }
export function ensureCalendarPermission(): Promise<boolean> { return Promise.resolve(true); }
