import { fromData, toData, nativeArray } from '../native/kotlin-data'
declare const FaceclawKitIosProtocol: any
const protocol = FaceclawKitIosProtocol.new()
export function buildBoundingBoxPayload(previous: Uint8Array | null, next: Uint8Array, width: number, height: number, frameId: number): Uint8Array | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
    width % 4 || height % 2 || width / 4 > 255 || height / 2 > 255 ||
    !previous || previous.length !== width * height / 2 || next.length !== previous.length) return null
  const result = protocol.boundingBoxPreviousNextWidthHeightFrameId(toData(previous), toData(next), width, height, frameId)
  return result ? fromData(result) : null
}
export function buildFullFrameBands(packed: Uint8Array, width: number, height: number, firstId: number): Uint8Array[] {
  if (width <= 0 || width > 640 || width % 4 || height <= 0 || height > 480 || height % 2 || packed.length !== width * height / 2)
    throw new Error('Invalid framebuffer dimensions')
  return nativeArray(protocol.fullFrameBandsDataWidthHeightFirstId(toData(packed), width, height, firstId), fromData)
}
