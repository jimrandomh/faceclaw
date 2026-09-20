/**
 * Hex ⇄ byte helpers shared by the advertisement parsers and the firmware
 * builder. Pure (no NativeScript imports) so it can run under node tests.
 */

/** Lenient decode: non-hex characters (separators, whitespace) are stripped first. */
export function hexToBytes(hex: string | null | undefined): Uint8Array {
  const clean = (hex ?? "").replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: ArrayLike<number>): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i]! & 0xff).toString(16).padStart(2, "0").toUpperCase();
  }
  return out;
}
