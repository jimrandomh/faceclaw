/**
 * Atlas ids every JS context can compute alone. On the phones, every isolate asks
 * one process-wide Kotlin object for its ids; Web Workers can't reach it
 * synchronously, so here the id is a hash of the key the atlases are keyed by
 * anyway. A collision would only misdraw one animated preview's text, in a
 * namespace of a few dozen fonts per page.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A font id: the wire field is 16 bits, and 0 means none. */
export function textureFontIdFor(key: string): number {
  return ((fnv1a(key) ^ (fnv1a(key) >>> 16)) & 0xffff) || 1;
}

/** An image id: bit 30 keeps it clear of ImageAtlas's sequential ids (see ImageAtlas.ensureWithId). */
export function textureImageIdFor(key: string): number {
  return (fnv1a(key) & 0x3fffffff) | 0x40000000;
}
