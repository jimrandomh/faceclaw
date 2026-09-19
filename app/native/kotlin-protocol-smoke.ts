declare const com: any

/** Development-only checks of NativeScript metadata and bulk ByteBuffer crossings. */
export function runKotlinProtocolSmokeTest(): void {
  const native = com.faceclaw.app
  const hex = (data: any) => Array.from({ length: data.length }, (_, i) => (data[i] & 255).toString(16).padStart(2, '0')).join('')
  const assert = (condition: boolean, what: string) => { if (!condition) throw new Error(`Kotlin protocol bridge: ${what}`) }
  const auth = native.BleProtocol.buildAuthenticationRequest(101)
  assert(hex(auth) === '080410651a0408011004', 'authentication')
  const compositor = new native.SurfaceCompositor()
  compositor.configureScreen(3, 2)
  compositor.configureSurface('test', 0, 0, 3, 2, 0, 0)
  const pixels = new Uint8Array([0, 16, 255, 32, 48, 64])
  compositor.submitSurface('test', new native.AndroidByteReader(pixels.buffer), 0, 0, 3, 2, '1')
  assert(hex(compositor.composite().gray) === '0010ff203040', 'composition/ByteBuffer')
  assert(hex(native.BmpUtil.pack4bppFromGray8(compositor.composite().gray, 3, 2)) === '01f02340', 'packing')
  const id = native.ImageAtlas.ensure('kotlin-smoke', 3, 2, new native.AndroidByteReader(pixels.buffer))
  assert(id > 0 && native.ImageAtlas.get(id).width === 3, 'image atlas/reused buffer')
  console.log('FACECLAW_KOTLIN_PROTOCOL_PASS Android')
}
