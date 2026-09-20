/** Bulk binary bridge; slices are normalized without per-byte native calls. */
export function toData(bytes: Uint8Array): NSData {
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer : bytes.slice().buffer
  return NSData.dataWithBytesLength(interop.handleof(buffer), bytes.byteLength)
}
export function fromData(data: NSData): Uint8Array {
  return new Uint8Array(interop.bufferFromData(data)).slice()
}
export function nativeArray<T, R>(items: NSArray<T>, convert: (item: T) => R): R[] {
  return Array.from({ length: items.count }, (_, i) => convert(items.objectAtIndex(i)))
}
