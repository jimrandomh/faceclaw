import { fromData, toData, nativeArray } from '../native/kotlin-data'
declare const FaceclawKitIosCfwTransport: any, FaceclawKitIosProtocol: any
export const CFW_MAX_MESSAGE = 65535
export type CfwAck = { nack: boolean; streamId: number; messageId: number; lens: number; size: number; checksum: number }
/** maxWrite is the ATT value limit; Kotlin owns the persistent zlib stream. */
export class CfwTransport {
  private native = FaceclawKitIosCfwTransport.new()
  reset(): void { this.native.reset() }
  encode(message: Uint8Array, streamId: number, lenses: number, maxWrite: number): Uint8Array[] {
    if (message.length > CFW_MAX_MESSAGE || !Number.isInteger(streamId) || streamId < 0 || streamId > 255 ||
      ![1, 2, 3].includes(lenses) || !Number.isInteger(maxWrite) || maxWrite < 20 || maxWrite > 514)
      throw new Error('Invalid CFW stream parameters')
    return nativeArray(this.native.encodeDataStreamIdLensesMaxWrite(toData(message), streamId, lenses, maxWrite), fromData)
  }
}
const protocol = FaceclawKitIosProtocol.new()
export function parseCfwAcks(packet: Uint8Array): CfwAck[] | null {
  const acks = protocol.acksData(toData(packet))
  return acks ? nativeArray(acks, (ack: any) => ({ nack: ack.nack, streamId: ack.streamId, messageId: ack.messageId,
    lens: ack.lens, size: ack.size, checksum: ack.checksum })) : null
}
