import { GrayImage } from "../graphics/image"
import { encodeShellScene } from "../graphics/shell-scene"
import { decodeImageBytes } from './image-bytes.ios'
import * as protocol from '../g2/ble-protocol.ios'
import { SurfaceCompositor } from '../graphics/surface-compositor.ios'
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
  const c = new SurfaceCompositor(3, 2)
  c.configureSurface('test', { x: 0, y: 0, width: 3, height: 2, zOrder: 0, transparency: 'opaque' })
  c.submitSurfaceFrame('test', new Uint8Array([0, 16, 255, 32, 48, 64]), { x: 0, y: 0, width: 3, height: 2 })
  assert(hex(c.composite()) === '0010ff203040', 'composition')
  assert(hex(protocol.packGray4(c.composite(), 3, 2)) === '01f02340', 'packing')
  c.setShellScene(new Uint8Array([1,0,1,0,0,0,0,0,1,0,1,0,128,0,0,0,0,0,255]))
  assert(hex(c.composite()) === 'f00070101020', 'shell scene bridge and 4bpp composition')
  c.setScreenBlanked(true); assert(c.composite().every(p => p === 0), 'blanking')
  const selectedSurface = new GrayImage(8, 4, 1)
  selectedSurface.drawMenuSelection(new GrayImage(4, 2, 255), 1, 1, 16, 48, 0, 2)
  const selectedPreview = new SurfaceCompositor(8, 4)
  selectedPreview.setShellScene(encodeShellScene([{ image: selectedSurface, x: 0, y: 0, shellKey: 100 }]))
  const selectedPixels = selectedPreview.composite()
  assert(selectedPixels[10] === 240 && selectedPixels[9] === 0, 'menu selection depth and bridge')
  assert(lvglMetrics('/nonexistent/faceclaw-font').length === 0, 'font bridge')
  const compass = protocol.decodeCompassInput({ sid: 8, flag: 1, command: 15, magic: 0,
    payload: new Uint8Array([8, 15, 16, 0, 82, 3, 8, 231, 2, 162, 6, 12, 67, 77, 1, 3, 2, 3, 140, 0, 152, 186, 220, 254]) })
  if (compass?.headingDegrees !== 359 || compass.diagnostics?.sampleTimeMs !== 0xfedcba98)
    throw new Error('Kotlin compass notification mismatch')
  const png = NSData.alloc().initWithBase64EncodedStringOptions('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC', 0 as NSDataBase64DecodingOptions)
  const decoded = decodeImageBytes(interop.bufferFromData(png), 2, 2)
  assert(!!decoded && Array.from(decoded.pixels).join(',') === '54,182,18,255', 'native map image orientation and grayscale')
  assert(decodeImageBytes(new ArrayBuffer(0), 2, 2) === null, 'invalid map image')
  console.log('FACECLAW_KOTLIN_PROTOCOL_PASS iOS')
}
