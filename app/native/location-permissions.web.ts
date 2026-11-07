export const hasLocationPermission = (): boolean => true;
export function ensureLocationPermission(): Promise<boolean> { return Promise.resolve(true); }
export function ensureFineLocationPermission(): Promise<boolean> { return Promise.resolve(true); }
