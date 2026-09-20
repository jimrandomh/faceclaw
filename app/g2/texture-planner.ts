/** Platform-owned snapshot of the same composite as the submitted pixels. */
export type TextureFrame = { readonly native: object }
export type TexturePlan = { uploads: Uint8Array[]; payload: Uint8Array; nextFid: number; usedBytes: number }
/** Sessions own residency; frame snapshots may be coalesced without changing it. */
export interface SessionTexturePlanner {
  plan(previous: Uint8Array | null, next: Uint8Array, frame: TextureFrame, firstId: number): TexturePlan | null
  reset(): void
}
