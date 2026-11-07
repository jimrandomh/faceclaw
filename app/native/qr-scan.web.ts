export function isQrScannerAvailable(): boolean { return false; }
export function scanQrCode(): Promise<string | null> { return Promise.resolve(null); }
export function cancelQrScan(): void {}
