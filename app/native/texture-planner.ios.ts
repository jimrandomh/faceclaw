import { fromData, toData, nativeArray } from './kotlin-data'
import type { SessionTexturePlanner, TextureFrame, TexturePlan } from '../g2/texture-planner'
declare const FaceclawKitIosTexturePlanner: any

export class IosTexturePlanner implements SessionTexturePlanner {
  private readonly native = FaceclawKitIosTexturePlanner.new()
  reset(): void { this.native.reset() }
  plan(previous: Uint8Array | null, next: Uint8Array, frame: TextureFrame, firstId: number): TexturePlan | null {
    const result = this.native.planPreviousNextFrameFirstId(previous ? toData(previous) : null, toData(next), frame.native, firstId)
    return result ? { payload: fromData(result.payload), resourceCommands: nativeArray(result.resourceCommands, fromData),
      nextFid: result.nextFid, usedBytes: result.usedBytes } : null
  }
}
