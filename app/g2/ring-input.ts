/** Original R1 report metadata. Tick is unsigned ring uptime, not phone time.
 * Keep the native clock units: G2's deduplication threshold is 100 ticks. */
export type RingInput = Readonly<{ tick: number; type: number; aux: number; speed: number }>;

/** Faceclaw/19 EvenHub SysEvent field 100, version 1. */
export function decodeRingMetadata(raw: Uint8Array | null | undefined): RingInput | undefined {
  if (!raw || raw.length !== 12 || raw[0] !== 0x52 || raw[1] !== 0x49 ||
      raw[2] !== 1 || raw[3] !== 1 || raw[7] !== 0) return undefined;
  return { tick: (raw[8] | raw[9] << 8 | raw[10] << 16 | raw[11] << 24) >>> 0,
    type: raw[4], aux: raw[5], speed: raw[6] };
}
