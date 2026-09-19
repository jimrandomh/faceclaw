import { toData, fromData } from './kotlin-data'
declare const FaceclawCrypto: any
export function firmwareSha256(buffer: ArrayBuffer): string { return String(FaceclawCrypto.sha256(toData(new Uint8Array(buffer)))) }
export function writeFirmwareFile(path: string, buffer: ArrayBuffer): void {
  if (!toData(new Uint8Array(buffer)).writeToFileAtomically(path, true)) throw new Error('Could not save the verified firmware image.')
}
export function readFirmwareFile(path: string): Uint8Array {
  const data = NSData.dataWithContentsOfFile(path)
  if (!data) throw new Error('Could not read the prepared firmware image.')
  return fromData(data)
}
