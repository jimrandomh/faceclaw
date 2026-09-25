/** Workers send baked pixels and shared-Kotlin atlas references together. */
const display = {
  submitSurfaceFrame(buffer: ArrayBuffer, surfaceId: string, _x: number, _y: number, width: number, height: number,
    _fingerprint?: string, _paintMs?: number, _frameId?: number, draws: ArrayBuffer | null = null): void {
    const data = NSData.dataWithBytesLength(interop.handleof(buffer), buffer.byteLength)
    const drawData = draws ? NSData.dataWithBytesLength(interop.handleof(draws), draws.byteLength) : null
    global.postMessage({ type: 'surface-frame', surfaceId, width, height,
      pixels: data.base64EncodedStringWithOptions(0 as NSDataBase64EncodingOptions),
      draws: drawData?.base64EncodedStringWithOptions(0 as NSDataBase64EncodingOptions) })
  },
}
export function getActiveDisplay(): typeof display { return display }
