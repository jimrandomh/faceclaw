import { decodePngToGray } from "./image-files";
import { GrayImage } from "../graphics/image";

export function decodeImageBytes(bytes: ArrayBuffer, width: number, height: number): GrayImage | null {
  return decodePngToGray(new Uint8Array(bytes), width, height);
}
