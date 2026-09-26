import { copyToJavaByteBuffer } from './java-direct-buffer'

declare const com: any

// The image crosses as a fresh Java buffer: passing a JS ArrayBuffer to Java
// leaks it (java-direct-buffer.ts).
export function firmwareSha256(buffer: ArrayBuffer): string { return String(com.faceclaw.app.FaceclawFirmwareUtil.sha256Hex(copyToJavaByteBuffer(new Uint8Array(buffer)))) }
export function writeFirmwareFile(path: string, buffer: ArrayBuffer): void { com.faceclaw.app.FaceclawFirmwareUtil.writeFile(path, copyToJavaByteBuffer(new Uint8Array(buffer))) }
