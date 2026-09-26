import { grayImageFromPacket } from './image-files'
import { type GrayImage } from '../graphics/image'
import { copyToJavaByteBuffer } from './java-direct-buffer'
declare const com: any

/** The encoded bytes cross as a fresh Java buffer; passing the ArrayBuffer leaks it (java-direct-buffer.ts). */
export function decodeImageBytes(bytes: ArrayBuffer, width: number, height: number): GrayImage | null {
  return grayImageFromPacket(com.faceclaw.app.ImageFileLoader.loadGrayFromBytes(copyToJavaByteBuffer(new Uint8Array(bytes)), width, height))
}
