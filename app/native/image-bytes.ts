import { grayImageFromPacket } from './image-files'
import { type GrayImage } from '../graphics/image'
declare const com: any

export function decodeImageBytes(bytes: ArrayBuffer, width: number, height: number): GrayImage | null {
  return grayImageFromPacket(com.faceclaw.app.ImageFileLoader.loadGrayFromBytes(bytes, width, height))
}
