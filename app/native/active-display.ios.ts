/** Workers send baked grayscale frames to the main-thread iOS compositor. */
const display = {
  submitSurfaceFrame(buffer: ArrayBuffer, surfaceId: string, _x: number, _y: number, width: number, height: number): void {
    const data = NSData.dataWithBytesLength(interop.handleof(buffer), buffer.byteLength)
    global.postMessage({ type: 'surface-frame', surfaceId, width, height, pixels: data.base64EncodedStringWithOptions(0 as NSDataBase64EncodingOptions) })
  },
}
export function getActiveDisplay(): typeof display { return display }
