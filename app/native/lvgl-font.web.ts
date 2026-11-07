import { WebProtocol } from "faceclaw-kit";

const unsigned = (bytes: Int8Array) => new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function lvglMetrics(path: string): Uint8Array {
  return unsigned(WebProtocol.getInstance().fontMetrics(path));
}

export function lvglGlyph(path: string, codePoint: number): Uint8Array {
  return unsigned(WebProtocol.getInstance().fontGlyph(path, codePoint));
}
