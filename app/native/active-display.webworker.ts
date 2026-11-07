/** Frames go to the main thread's compositor (app/web/workers.ts); postMessage copies the pixels. */
const display = {
  submitSurfaceFrame(buffer: ArrayBuffer, surfaceId: string, _x: number, _y: number, width: number, height: number,
    _fingerprint?: string, _paintMs?: number, _frameId?: number, draws: ArrayBuffer | null = null): void {
    global.postMessage({ type: "surface-frame", surfaceId, width, height, pixels: new Uint8Array(buffer), draws });
  },
};

export function getActiveDisplay(): typeof display {
  return display;
}
