import { iosBluetooth } from './ios-bluetooth'
export async function ensureBlePermissions(): Promise<void> { await iosBluetooth().ensureReady() }
