declare const com: any
export function firmwareSha256(buffer: ArrayBuffer): string { return String(com.faceclaw.app.FaceclawFirmwareUtil.sha256Hex(buffer)) }
export function writeFirmwareFile(path: string, buffer: ArrayBuffer): void { com.faceclaw.app.FaceclawFirmwareUtil.writeFile(path, buffer) }
