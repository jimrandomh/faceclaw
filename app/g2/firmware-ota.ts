/** Stock EVENOTA validation and transfer, matching Android's flasher/g2flash.py. */
import { StockConnection, OTA_WRITE, OTA_NOTIFY } from './stock-connection'
import { concat } from './ble-protocol'
import type { FlashProgress } from './firmware-types'

export type FirmwareSegment = { offset: number; size: number; name: string }
const CRC_TABLE = Array.from({ length: 256 }, (_, b) => {
  let c = b << 24
  for (let i = 0; i < 8; i++) c = c & 0x80000000 ? (c << 1) ^ 0x1edc6f41 : c << 1
  return c >>> 0
})
export function firmwareCrc(data: Uint8Array): number {
  let crc = 0
  for (const byte of data) crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 255]
  return crc >>> 0
}
export function validateFirmware(image: Uint8Array): FirmwareSegment[] {
  const u32 = (offset: number) => {
    if (offset < 0 || offset + 4 > image.length) throw new Error('Firmware header is truncated.')
    return new DataView(image.buffer, image.byteOffset, image.byteLength).getUint32(offset, true)
  }
  if (image.length < 0x40) throw new Error('File is too small to be a firmware image.')
  const count = u32(8)
  if (count < 5 || count > 6 || 0x40 + count * 16 > image.length) throw new Error('Expected 5–6 firmware components.')
  const segments: FirmwareSegment[] = []
  for (let i = 0; i < count; i++) {
    const toc = 0x40 + i * 16, offset = u32(toc + 4)
    if (offset < 0x40 + count * 16 || offset + 128 > image.length) throw new Error('Firmware component header is out of bounds.')
    const size = u32(offset + 8), end = offset + 128 + size
    if (!size || end > image.length) throw new Error('Firmware component payload is truncated.')
    if (segments.some(s => offset < s.offset + 128 + s.size && s.offset < end)) throw new Error('Firmware components overlap.')
    const nameBytes = image.subarray(offset + 48, offset + 128)
    const name = String.fromCharCode(...nameBytes.subarray(0, nameBytes.indexOf(0) < 0 ? 80 : nameBytes.indexOf(0)))
    const crc = firmwareCrc(image.subarray(offset + 128, end))
    if (crc !== u32(toc + 12) || crc !== u32(offset + 12)) throw new Error(`Component ${name} CRC32C is stale (image not checksum-fixed).`)
    segments.push({ offset, size, name })
  }
  const mains = segments.filter(s => s.name === 'ota/s200_firmware_ota.bin')
  if (mains.length !== 1) throw new Error('Required main firmware component is missing or duplicated.')
  const main = mains[0], payload = main.offset + 128
  if (main.size < 32 || u32(payload + 0x14) !== 0x00438000 || (u32(payload) & 0xffffff) !== main.size)
    throw new Error('Main-app preamble load address or length is invalid.')
  if (0x00438000 + main.size - 32 > 0x007f0000) throw new Error('Main-app exceeds the safe MRAM ceiling — refusing to flash.')
  return segments
}

export async function flashLensImage(link: StockConnection, role: string, image: Uint8Array, segments: FirmwareSegment[],
  progress: (value: FlashProgress) => void, log: (line: string) => void,
  delay: (ms: number) => Promise<void>): Promise<void> {
  let sequence = 0
  const ctrl = async (op: number, payload = new Uint8Array(), data?: Uint8Array): Promise<number> => {
    sequence = (sequence + 1) & 255
    const message = await link.exchange(role, 0xc0, concat(new Uint8Array([op]), payload),
      message => message.command === op, data ? 4000 : 8000, OTA_WRITE, OTA_NOTIFY, 0, sequence, data)
    return message.payload[1]
  }
  const accepted = (status: number) => [0, 8, 9].includes(status)
  const begin = await ctrl(0)
  if (!accepted(begin)) throw new Error(`OTA BEGIN rejected (status ${begin}).`)
  const total = segments.reduce((sum, segment) => sum + segment.size, 0)
  let before = 0
  for (const [index, segment] of segments.entries()) {
    let verified = false, failure: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      link.check()
      if (attempt) { log(`${segment.name}: re-flash attempt ${attempt + 1}/3`); await delay(1500) }
      try {
        const status = await ctrl(1, image.slice(segment.offset, segment.offset + 128))
        if (status !== 0) throw new Error(`FILE_CHECK rejected (status ${status}).`)
        const blocks = Math.ceil(segment.size / 4096)
        for (let block = 0; block < blocks; block++) {
          const start = segment.offset + 128 + block * 4096
          const data = image.slice(start, Math.min(start + 4096, segment.offset + 128 + segment.size))
          let ok = false
          for (let retry = 0; retry < 3; retry++) {
            if (await ctrl(2, new Uint8Array(), data) === 0) { ok = true; break }
          }
          if (!ok) throw new Error(`Block ${block + 1} rejected three times.`)
          if (block % 20 === 0 || block === blocks - 1)
            progress({ lens: role, componentIndex: index + 1, componentCount: segments.length, blockIndex: block + 1,
              blockCount: blocks, bytesSent: before + Math.min((block + 1) * 4096, segment.size), bytesTotal: total })
        }
        const end = await ctrl(3)
        if (!accepted(end)) throw new Error(`END verification failed (status ${end}).`)
        log(`${role} ${segment.name}: END verify OK (status ${end})`); verified = true; break
      } catch (error) { link.check(); failure = error }
    }
    if (!verified) throw new Error(`Component ${segment.name} failed after 3 attempts: ${failure}`)
    before += segment.size
  }
}
