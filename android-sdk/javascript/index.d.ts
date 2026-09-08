export type Rect = { x: number; y: number; width: number; height: number };
export type MotionFrame = { rect: Rect; progress: number; bodyVisible: boolean; closing: boolean; done: boolean };
export const FRAME_INTERVAL_MS: 40;
export const DURATION_MS: 360;
export const BODY_REVEAL_PROGRESS: 0.9;
export function interpolateRect(from: Rect, to: Rect, progress: number): Rect;
export class WindowMotion {
  constructor(from: Rect, to: Rect, closing?: boolean);
  from: Rect; to: Rect; closing: boolean; started: number | null; lastRect: Rect; active: boolean;
  sample(now: number): MotionFrame | null;
  retarget(to: Rect, closing: boolean): void;
  cancel(): void;
}
export class FrameRequest {
  constructor(render: () => void, schedule?: (callback: () => void) => any, unschedule?: (handle: any) => void);
  request(): void;
  cancel(): void;
}

export class WindowAnimator {
  constructor(render: (frame: MotionFrame) => void, options?: { now?: () => number; schedule?: (callback: () => void, delay: number) => any; unschedule?: (handle: any) => void });
  start(from: Rect, to: Rect, closing?: boolean): void;
  retarget(to: Rect, closing: boolean): void;
  cancel(): void;
  isRunning(): boolean;
}
