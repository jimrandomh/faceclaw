
export function toUint8Array(bytes: ArrayLike<number> | null | undefined): Uint8Array {
  if (!bytes) return new Uint8Array(0);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i]! & 0xff;
  }
  return out;
}
