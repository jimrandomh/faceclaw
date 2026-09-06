/** G2 wire protocol, ported from g2protocol/BleProtocol.java. No platform APIs. */
export const G2_WRITE = '00002760-08c2-11e1-9073-0e8ac72e5401'
export const G2_NOTIFY = '00002760-08c2-11e1-9073-0e8ac72e5402'
export const G2_RENDER_NOTIFY = '00002760-08c2-11e1-9073-0e8ac72e6402'
export const RING_NOTIFY = ['bae80011-4f05-4503-8e65-3af1f7329d1f', 'bae80013-4f05-4503-8e65-3af1f7329d1f']
export const SID = { auth: 0x80, launch: 1, hub: 0xe0, settings: 9 } as const
export function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length }; return output
}
function varint(value: number): Uint8Array {
  const bytes: number[] = []
  do { const next = value & 127; value >>>= 7; bytes.push(next | (value ? 128 : 0)) } while (value)
  return new Uint8Array(bytes)
}
export const integer = (field: number, value: number): Uint8Array => concat(varint(field * 8), varint(value))
export const bytes = (field: number, value: Uint8Array): Uint8Array => concat(varint(field * 8 + 2), varint(value.length), value)
// Outbound names/text here are fixed ASCII protocol identifiers.
const string = (field: number, value: string): Uint8Array => bytes(field, new Uint8Array(Array.from(value, c => c.charCodeAt(0))))
const wrap = (command: number, magic: number, field: number, body: Uint8Array) => concat(integer(1, command), integer(2, magic), bytes(field, body))
export const authentication = (magic: number) => wrap(4, magic, 3, concat(integer(1, 1), integer(2, 4)))
export const prelude = () => wrap(2, 156, 4, bytes(3, bytes(2, bytes(2, concat(integer(1, 0), integer(2, 0))))))
export const heartbeat = (magic: number) => wrap(12, magic, 14, integer(1, 0))
export const settingsQuery = (magic: number) => wrap(2, magic, 4, integer(1, 1))
export const shutdown = (magic: number) => wrap(9, magic, 11, integer(1, 1))
export const framebufferLease = (acquire: boolean) => concat(integer(1, 1), integer(2, 0), bytes(101, new Uint8Array([70, 67, 1, acquire ? 5 : 6, 0, 0])))
export function createLayout(magic: number): Uint8Array {
  const geometry = concat(integer(1, 0), integer(2, 0), integer(3, 576), integer(4, 288))
  const text = concat(geometry, integer(9, 1), string(10, 'dashboard'), integer(11, 1), string(12, ' '))
  const image = concat(geometry, integer(5, 10), string(6, 'img00'))
  return wrap(0, magic, 3, concat(integer(1, 2), bytes(3, text), bytes(4, image), integer(5, 10000)))
}
export function imageFragment(magic: number, payload: Uint8Array, offset: number, size = 3800): Uint8Array {
  const fragment = payload.subarray(offset, offset + size)
  return wrap(3, magic, 5, concat(integer(1, 10), string(2, 'img00'), integer(3, 10), integer(4, payload.length),
    integer(5, 0), integer(6, Math.floor(offset / size)), integer(7, fragment.length), bytes(8, fragment)))
}
export function crc16(data: Uint8Array): number {
  let crc = 0xffff
  for (const byte of data) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff
  }
  return crc
}
export function frameMessage(payload: Uint8Array, sid: number, flag: number, sequence: number, maxWrite = 240): Uint8Array[] {
  const chunkSize = Math.min(232, Math.floor(maxWrite) - 8)
  if (chunkSize < 12) throw new Error('Negotiated BLE write size is too small')
  const crc = crc16(payload), withCrc = concat(payload, new Uint8Array([crc & 255, crc >>> 8]))
  const count = Math.ceil(withCrc.length / chunkSize)
  if (count > 255) throw new Error('Protocol message exceeds the fragment limit')
  return Array.from({ length: count }, (_, i) => {
    const chunk = withCrc.subarray(i * chunkSize, (i + 1) * chunkSize)
    return concat(new Uint8Array([0xaa, 0x21, sequence & 255, chunk.length, count, i + 1, sid, flag]), chunk)
  })
}
export type ProtocolMessage = { sid: number; flag: number; payload: Uint8Array; command: number; magic: number }
/** Handles split/coalesced envelopes and reassembles each link/sequence separately. */
export class MessageReceiver {
  private streams = new Map<string, Uint8Array>()
  private messages = new Map<string, { chunks: Uint8Array[]; total: number; seen: number; size: number }>()
  clear(): void { this.streams.clear(); this.messages.clear() }
  receive(link: string, data: Uint8Array, now = Date.now()): ProtocolMessage[] {
    for (const [key, message] of this.messages) if (now - message.seen > 5000) this.messages.delete(key)
    let stream = concat(this.streams.get(link) ?? new Uint8Array(), data)
    const output: ProtocolMessage[] = []
    while (stream.length >= 8) {
      if (stream[0] !== 0xaa || ![0x21, 0x12].includes(stream[1])) { stream = stream.subarray(1); continue }
      const length = stream[3], count = stream[4], index = stream[5]
      if (stream.length < length + 8) break
      const sid = stream[6], flag = stream[7], key = `${link}:${stream[2]}:${sid}:${flag}`
      const chunk = stream.slice(8, 8 + length); stream = stream.subarray(length + 8)
      if (!count || !index || index > count) { this.messages.delete(key); continue }
      if (index === 1) this.messages.set(key, { chunks: [], total: count, seen: now, size: 0 })
      const message = this.messages.get(key)
      if (!message || message.total !== count || message.chunks.length + 1 !== index) { this.messages.delete(key); continue }
      message.chunks.push(chunk); message.size += chunk.length; message.seen = now
      if (message.size > 65536) { this.messages.delete(key); continue }
      if (index !== count) continue
      this.messages.delete(key)
      const complete = concat(...message.chunks)
      if (complete.length < 2) continue
      const payload = complete.subarray(0, -2), crc = complete[complete.length - 2] | (complete[complete.length - 1] << 8)
      if (crc16(payload) !== crc) continue
      try { output.push({ sid, flag, payload, command: readInteger(payload, 1, -1), magic: readInteger(payload, 2, -1) }) }
      catch { /* Malformed notifications cannot satisfy an acknowledgement. */ }
    }
    this.streams.set(link, stream.slice())
    return output
  }
}
function readVarint(data: Uint8Array, offset: number): [number, number] {
  let value = 0
  for (let i = 0; i < 5 && offset < data.length; i++) {
    const byte = data[offset++]; value += (byte & 127) * 2 ** (i * 7)
    if (!(byte & 128)) return [value, offset]
  }
  throw new Error('Truncated or oversized protobuf varint')
}
function field(data: Uint8Array, number: number): number | Uint8Array | undefined {
  let offset = 0
  while (offset < data.length) {
    let key: number; [key, offset] = readVarint(data, offset)
    const tag = key >>> 3, wire = key & 7
    if (!tag) throw new Error('Invalid protobuf field')
    if (wire === 0) {
      let value: number; [value, offset] = readVarint(data, offset)
      if (tag === number) return value
    } else {
      let length: number
      if (wire === 2) [length, offset] = readVarint(data, offset)
      else if (wire === 1) length = 8
      else if (wire === 5) length = 4
      else throw new Error('Unsupported protobuf wire type')
      if (offset + length > data.length) throw new Error('Truncated protobuf field')
      if (tag === number && wire === 2) return data.subarray(offset, offset + length)
      offset += length
    }
  }
  return undefined
}
export function readInteger(data: Uint8Array, number: number, fallback = 0): number { const value = field(data, number); return typeof value === 'number' ? value : fallback }
export function readBytes(data: Uint8Array, number: number): Uint8Array | undefined { const value = field(data, number); return value instanceof Uint8Array ? value : undefined }
export function readString(data: Uint8Array, number: number): string { return Array.from(readBytes(data, number) ?? [], value => String.fromCharCode(value)).join('') }
export function authenticationSucceeded(message: ProtocolMessage, magic: number): boolean {
  return message.sid === SID.auth && message.command === 4 && message.magic === magic && readBytes(message.payload, 3)?.length === 0
}
export type GlassesInput = { kind: 'sys-event' | 'list-click' | 'text-click'; eventType: number; eventSource: number; systemExitReasonCode: number; containerName: string; frameId: number }
export function decodeGlassesInput(message: ProtocolMessage): GlassesInput | null {
  if (message.sid !== SID.hub || ![1, 6].includes(message.flag)) return null
  const events = readBytes(message.payload, 13); if (!events) return null
  for (const [field, kind, typeField] of [[1, 'list-click', 5], [2, 'text-click', 3], [3, 'sys-event', 1]] as const) {
    const event = readBytes(events, field)
    if (event) return { kind, eventType: readInteger(event, typeField), eventSource: field === 3 ? readInteger(event, 2) : 0,
      systemExitReasonCode: field === 3 ? readInteger(event, 4) : 0, containerName: field === 3 ? '' : readString(event, 2), frameId: 0 }
  }
  return null
}
export function decodeRingInput(data: Uint8Array): GlassesInput | null {
  let eventType: number | undefined
  if (data.length === 11 && data[0] === 0 && data[1] === 9 && data[2] === 0x61 && data[3] === 0)
    eventType = ({ 0: 9, 1: 0, 2: 3, 4: 1, 5: 2, 8: 10 } as Record<number, number>)[data[4]]
  if (data.length === 3 && data[0] === 255) {
    if (data[1] === 3 && data[2] === 32) eventType = 9
    if (data[1] === 4 && data[2] === 1) eventType = 0
    if (data[1] === 4 && data[2] === 2) eventType = 3
    if (data[1] === 5) eventType = data[2] <= 1 ? 2 : 1
  }
  return eventType === undefined ? null : { kind: 'sys-event', eventType, eventSource: 2, systemExitReasonCode: 0, containerName: '', frameId: 0 }
}
export function packGray4(gray: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || gray.length !== width * height) throw new Error('Invalid display frame')
  const stride = Math.ceil(width / 2), packed = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const nibble = Math.min(15, (gray[y * width + x] + 8) >> 4)
    packed[y * stride + (x >> 1)] |= nibble << (x % 2 ? 0 : 4)
  }
  return packed
}
export function rle4(packed: Uint8Array): Uint8Array {
  const output = new Uint8Array(packed.length * 2)
  const nibble = (i: number) => (packed[i >> 1] >> (i % 2 ? 0 : 4)) & 15
  let used = 0, i = 0
  while (i < packed.length * 2) {
    const color = nibble(i); let end = i + 1
    while (end < packed.length * 2 && nibble(end) === color) end++
    let remaining = end - i
    while (remaining) {
      const count = Math.min(65535, remaining)
      if (count <= 15) output[used++] = (count << 4) | color
      else { output[used++] = color; if (count <= 255) output[used++] = count
        else { output[used++] = 0; output[used++] = count & 255; output[used++] = count >>> 8 } }
      remaining -= count
    }
    i = end
  }
  return output.slice(0, used)
}
