import * as protocol from '../g2/ble-protocol.ios'
import { CfwTransport, parseCfwAcks } from '../g2/cfw-transport.ios'
import { SurfaceCompositor } from '../graphics/surface-compositor.ios'
import { buildBoundingBoxPayload } from '../g2/ble-image-optimizer.ios'
import { lvglMetrics } from './lvgl-font.ios'

/** Development-only checks of real NativeScript selectors and bulk data crossings. */
export function runKotlinProtocolSmokeTest(): void {
  const hex = (data: Uint8Array) => Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('')
  const assert = (condition: boolean, what: string) => { if (!condition) throw new Error(`Kotlin protocol bridge: ${what}`) }
  const auth = protocol.authentication(101)
  assert(hex(auth) === '080410651a0408011004', 'authentication')
  assert(protocol.crc16(new Uint8Array([1, 2, 3])) === 0xadad, 'CRC')
  const receiver = new protocol.MessageReceiver()
  const frame = protocol.frameMessage(auth, 128, 0, 64)[0]
  const received = receiver.receive('test', frame)
  assert(received.length === 1 && received[0].magic === 101 && hex(received[0].payload) === hex(auth), 'reassembly')
  const payload = protocol.bytes(13, protocol.bytes(3, protocol.concat(protocol.integer(1, 12), protocol.integer(2, 2))))
  const event = protocol.decodeGlassesInput({ sid: 224, flag: 1, payload, command: 0, magic: 0 })
  assert(event?.kind === 'display-wake' && event.eventSource === 2, 'event')
  const transport = new CfwTransport()
  const packets = transport.encode(new Uint8Array(128).fill(9), 255, 3, 185)
  assert(packets.length > 0 && packets.every(p => p.length <= 185), 'compression')
  transport.reset()
  assert(parseCfwAcks(new Uint8Array()) === null, 'invalid ACK')
  const c = new SurfaceCompositor(3, 2)
  c.configureSurface('test', { x: 0, y: 0, width: 3, height: 2, zOrder: 0, transparency: 'opaque' })
  c.submitSurfaceFrame('test', new Uint8Array([0, 16, 255, 32, 48, 64]), { x: 0, y: 0, width: 3, height: 2 })
  assert(hex(c.composite()) === '0010ff203040', 'composition')
  assert(hex(protocol.packGray4(c.composite(), 3, 2)) === '01f02340', 'packing')
  c.setScreenBlanked(true); assert(c.composite().every(p => p === 0), 'blanking')
  const changed = new Uint8Array(16); changed[0] = 255
  assert(buildBoundingBoxPayload(new Uint8Array(16), changed, 8, 4, 1)?.[0] === 3, 'image update')
  assert(lvglMetrics('/nonexistent/faceclaw-font').length === 0, 'font bridge')
  console.log('FACECLAW_KOTLIN_PROTOCOL_PASS iOS')
}
