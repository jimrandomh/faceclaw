/**
 * Rebuilding the g1v0 image from what the app ships and Even's public firmware download. No I/O, so tests can run it
 * on real or made-up files. tools/g1_firmware_bundle.py is the other half.
 */
import { inflate, inflateRaw } from "pako";

import type { G1FirmwareImage } from "./firmware/g1v0-image";

export class G1FirmwareError extends Error {}

/** One file from a zip; throws when it's absent or in a form a firmware zip doesn't use. */
export function readZipEntry(zip: Uint8Array, name: string): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const END_OF_DIRECTORY = 0x06054b50;
  const DIRECTORY_ENTRY = 0x02014b50;
  const LOCAL_HEADER = 0x04034b50;
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== END_OF_DIRECTORY) end--;
  if (end < 0) throw new G1FirmwareError("The firmware download is not a zip file.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== DIRECTORY_ENTRY) break;
    const method = view.getUint16(at + 10, true);
    const packedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const headerAt = view.getUint32(at + 42, true);
    const entryName = String.fromCharCode(...zip.subarray(at + 46, at + 46 + nameLength));
    if (entryName === name || entryName.endsWith(`/${name}`)) {
      if (view.getUint32(headerAt, true) !== LOCAL_HEADER) throw new G1FirmwareError(`Bad zip entry for ${name}.`);
      const dataAt = headerAt + 30 + view.getUint16(headerAt + 26, true) + view.getUint16(headerAt + 28, true);
      const packed = zip.subarray(dataAt, dataAt + packedSize);
      if (method === 0) return packed.slice();
      if (method === 8) return inflateRaw(packed);
      throw new G1FirmwareError(`${name} uses zip method ${method}.`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new G1FirmwareError(`The firmware download has no ${name}.`);
}

export function decodeG1OwnBytes(base64: string, decode: (text: string) => Uint8Array): Uint8Array {
  return inflate(decode(base64));
}

/**
 * The finished image. [fileBytes] gives one of Even's unpacked files by name, [sha256] a lowercase hex digest. Each part
 * and the result are checked, so a success is byte for byte the image that was built and signed.
 */
export function assembleG1Image(
  manifest: G1FirmwareImage,
  own: Uint8Array,
  fileBytes: (name: string) => Uint8Array,
  sha256: (bytes: Uint8Array) => string,
): Uint8Array {
  const image = new Uint8Array(manifest.size);
  let position = 0;
  let ownAt = 0;
  for (const part of [...manifest.parts].sort((a, b) => a.offset - b.offset)) {
    const before = part.offset - position;
    image.set(own.subarray(ownAt, ownAt + before), position);
    ownAt += before;
    const bytes = fileBytes(part.file).subarray(part.fileOffset, part.fileOffset + part.length);
    if (bytes.length !== part.length || sha256(bytes) !== part.sha256) {
      throw new G1FirmwareError(`${part.file} in Even's download is not the one this firmware was built with.`);
    }
    image.set(bytes, part.offset);
    position = part.offset + part.length;
  }
  image.set(own.subarray(ownAt), position);
  if (ownAt + (manifest.size - position) !== own.length) {
    throw new G1FirmwareError("The firmware bundled with this app is damaged.");
  }
  const digest = sha256(image);
  if (digest !== manifest.sha256) {
    throw new G1FirmwareError(`The assembled firmware failed verification.\nexpected ${manifest.sha256}\ngot      ${digest}`);
  }
  return image;
}
