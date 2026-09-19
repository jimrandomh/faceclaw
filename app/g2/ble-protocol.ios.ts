import { type CompassEvent } from '../native/compass-types'
/** iOS binary bridge to the same Kotlin protocol used by Android. */
import { fromData, toData, nativeArray } from '../native/kotlin-data'
import { OsEventTypeList } from './events'
declare const FaceclawKitIosProtocol: any, FaceclawKitIosMessageReceiver: any
const protocol = FaceclawKitIosProtocol.new()
export const G2_WRITE = '00002760-08c2-11e1-9073-0e8ac72e5401'
export const G2_NOTIFY = '00002760-08c2-11e1-9073-0e8ac72e5402'
export const G2_RENDER_NOTIFY = '00002760-08c2-11e1-9073-0e8ac72e6402'
export const RING_NOTIFY = ['bae80011-4f05-4503-8e65-3af1f7329d1f', 'bae80013-4f05-4503-8e65-3af1f7329d1f']
export const SID = { auth: 0x80, launch: 1, hub: 0xe0, settings: 9, cfw: 0xf0 } as const
export function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) { output.set(part, offset); offset += part.length }
  return output
}
export const integer = (field: number, value: number): Uint8Array => fromData(protocol.integerFieldValue(field, value))
export const bytes = (field: number, value: Uint8Array): Uint8Array => fromData(protocol.bytesFieldData(field, toData(value)))
export const authentication = (magic: number) => fromData(protocol.authenticationMagic(magic))
export const prelude = () => fromData(protocol.prelude())
export const heartbeat = (magic: number) => fromData(protocol.heartbeatMagic(magic))
export const audioControl = (magic: number, enabled: boolean) => fromData(protocol.audioControlMagicEnabled(magic, enabled))
export const settingsQuery = (magic: number) => fromData(protocol.settingsQueryMagic(magic))
export const shutdown = (magic: number) => fromData(protocol.shutdownMagic(magic))
export const framebufferLease = (acquire: boolean) => fromData(protocol.framebufferLeaseAcquire(acquire))
export const createLayout = (magic: number) => fromData(protocol.createLayoutMagic(magic))
export const crc16 = (data: Uint8Array): number => protocol.crcData(toData(data))
export function frameMessage(payload: Uint8Array, sid: number, flag: number, sequence: number, maxWrite = 240): Uint8Array[] {
  const capacity = Math.min(232, Math.floor(maxWrite) - 8)
  if (capacity < 12 || !Number.isFinite(capacity)) throw new Error('Negotiated BLE write size is too small')
  if (Math.ceil((payload.length + 2) / capacity) > 255) throw new Error('Protocol message exceeds the fragment limit')
  return nativeArray(protocol.frameDataSidFlagSequenceMaxWrite(toData(payload), sid, flag, sequence, Math.floor(maxWrite)), fromData)
}
export type ProtocolMessage = { sid: number; flag: number; payload: Uint8Array; command: number; magic: number; packet?: Uint8Array }
export class MessageReceiver {
  private native = FaceclawKitIosMessageReceiver.new()
  clear(): void { this.native.clear() }
  receive(link: string, data: Uint8Array, now = Date.now()): ProtocolMessage[] {
    return nativeArray(this.native.receiveLinkDataNow(link, toData(data), now), (message: any) => ({
      sid: message.sid, flag: message.flag, payload: fromData(message.payload), command: message.command,
      magic: message.magic, ...(message.packet ? { packet: fromData(message.packet) } : {}),
    }))
  }
}
export const readInteger = (data: Uint8Array, field: number, fallback = 0): number => protocol.readIntegerDataFieldFallback(toData(data), field, fallback)
export const readBytes = (data: Uint8Array, field: number): Uint8Array | undefined => {
  const value = protocol.readBytesDataField(toData(data), field)
  return value ? fromData(value) : undefined
}
export const readString = (data: Uint8Array, field: number): string => protocol.readStringDataField(toData(data), field)
export function authenticationSucceeded(message: ProtocolMessage, magic: number): boolean {
  return message.sid === SID.auth && message.command === 4 && message.magic === magic && readBytes(message.payload, 3)?.length === 0
}
export type GlassesInput = { kind: 'sys-event' | 'list-click' | 'text-click' | 'display-wake' | 'even-ai'; eventType: number; eventSource: number; systemExitReasonCode: number; containerName: string; frameId: number }
function input(event: any): GlassesInput | null {
  return event ? { kind: event.kind === 'sys-event' && event.eventType === OsEventTypeList.HEAD_UP_EVENT ? 'display-wake' : event.kind,
    eventType: event.eventType, eventSource: event.eventSource, systemExitReasonCode: event.systemExitReasonCode,
    containerName: event.containerName, frameId: 0 } : null
}
export const decodeGlassesInput = (message: ProtocolMessage): GlassesInput | null => input(protocol.glassesInputDataSidFlag(toData(message.payload), message.sid, message.flag))
export const decodeRingInput = (data: Uint8Array): GlassesInput | null => input(protocol.ringInputData(toData(data)))
export function packGray4(gray: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || gray.length !== width * height) throw new Error('Invalid display frame')
  return fromData(protocol.packDataWidthHeight(toData(gray), width, height))
}
export const rle4 = (packed: Uint8Array): Uint8Array => fromData(protocol.rleData(toData(packed)))

export function decodeCompassInput(message: ProtocolMessage): CompassEvent | null {
  const event = protocol.compassInputDataSidFlag(toData(message.payload), message.sid, message.flag)
  return event ? { command: event.command, headingDegrees: event.headingDegrees,
    ...(event.diagnosticFlags >= 0 ? { diagnostics: {
      magneticAccuracy: event.magneticAccuracy, magneticAnomalies: event.magneticAnomalies,
      orientationSource: event.orientationSource, flags: event.diagnosticFlags, sampleTimeMs: Number(event.sampleTimeMs),
    } } : {}),
  } : null
}
