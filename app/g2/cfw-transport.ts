import { concat, crc16, SID } from './ble-protocol'

declare const require: (name: string) => any
export const CFW_MAX_MESSAGE = 65535
export type CfwAck = { nack: boolean; streamId: number; messageId: number; lens: number; size: number; checksum: number }
const u16 = (data: Uint8Array, offset: number) => data[offset] | (data[offset + 1] << 8)

/** Matches Android CfwTransport. maxWrite is the ATT value limit (MTU - 3). */
export class CfwTransport {
  private compressor: any
  private resetPending = true
  private lenses = 0
  reset(): void { this.compressor = null; this.resetPending = true; this.lenses = 0 }
  encode(message: Uint8Array, streamId: number, lenses: number, maxWrite: number): Uint8Array[] {
    if (message.length > CFW_MAX_MESSAGE || !Number.isInteger(streamId) || streamId < 0 || streamId > 255 ||
      ![1, 2, 3].includes(lenses) || !Number.isInteger(maxWrite) || maxWrite < 20 || maxWrite > 514)
      throw new Error('Invalid CFW stream parameters')
    if (this.lenses !== lenses) this.reset()
    if (!this.compressor) this.compressor = new (require('pako').Deflate)()
    const chunks: Uint8Array[] = []
    // SYNC_FLUSH emits this record while retaining history for the next one.
    this.compressor.onData = (chunk: Uint8Array) => chunks.push(chunk.slice())
    if (!this.compressor.push(message, 2)) throw new Error(this.compressor.msg || 'CFW compression failed')
    let body = concat(...chunks), flags = lenses | 4 | (this.resetPending ? 8 : 0)
    if (!body.length) flags &= ~4
    if (body.length > CFW_MAX_MESSAGE) {
      this.reset(); body = message; flags = lenses | 8
    } else { this.resetPending = false; this.lenses = lenses }
    const checksum = crc16(message)
    const record = concat(new Uint8Array([flags, body.length & 255, body.length >>> 8, checksum & 255, checksum >>> 8]), body)
    const capacity = Math.min(252, maxWrite - 11), packets: Uint8Array[] = []
    for (let offset = 0, index = 0; offset < record.length; offset += capacity, index++) {
      const body = concat(new Uint8Array([lenses | (offset === 0 ? 0x80 : 0) |
        (offset + capacity >= record.length ? 0x40 : 0)]), record.subarray(offset, offset + capacity))
      const crc = crc16(body)
      packets.push(concat(new Uint8Array([0xaa, 0x21, (streamId + index) & 255, body.length + 2, 1, 1, SID.cfw, 0]),
        body, new Uint8Array([crc & 255, crc >>> 8])))
    }
    return packets
  }
}

/** Validate the entire primary + redundant-ACK packet before applying any ACK. */
export function parseCfwAcks(packet: Uint8Array): CfwAck[] | null {
  const n = packet.length
  if (n < 19 || n > 40 || (n - 19) % 7 || packet[0] !== 0xaa || packet[1] !== 0x12 ||
    packet[3] !== n - 8 || packet[4] !== 1 || packet[5] !== 1 || packet[6] !== SID.cfw || packet[7] !== 0 ||
    ![1, 3].includes(packet[8]) || ![1, 2].includes(packet[12]) || (packet[8] === 3 && n !== 19) ||
    crc16(packet.subarray(8, -2)) !== u16(packet, n - 2)) return null
  const acks = [{ nack: packet[8] === 3, streamId: packet[9], messageId: u16(packet, 10),
    lens: packet[12], size: u16(packet, 13), checksum: u16(packet, 15) }]
  for (let offset = 17; offset < n - 2; offset += 7)
    acks.push({ nack: false, streamId: packet[offset], messageId: u16(packet, offset + 1), lens: packet[12],
      size: u16(packet, offset + 3), checksum: u16(packet, offset + 5) })
  return acks
}
