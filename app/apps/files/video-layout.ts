/**
 * Where a video goes in the player window, for each size choice. Pure
 * geometry, so it is unit-tested without the NativeScript runtime.
 */

export type VideoSize = "small" | "medium" | "large" | "full";

export const VIDEO_SIZES: readonly VideoSize[] = ["small", "medium", "large", "full"];

export type Size = { width: number; height: number };
export type Rect = Size & { x: number; y: number };

/**
 * Bounding boxes for the fixed sizes; a video is fitted inside, keeping its
 * aspect. Large and full fit the whole viewport instead (full in a tall
 * window). Bigger pictures cost the glasses link more per frame, so smaller
 * sizes play at a higher frame rate.
 */
const FIXED_BOXES: Partial<Record<VideoSize, Size>> = {
  small: { width: 160, height: 120 },
  medium: { width: 240, height: 180 },
};

export function videoSizeLabel(size: VideoSize): string {
  switch (size) {
    case "small":
      return "Small";
    case "medium":
      return "Medium";
    case "large":
      return "Large";
    case "full":
      return "Full screen";
  }
}

/** Full screen needs the tall window band; the rest play in the standard one. */
export function videoHeightMode(size: VideoSize): "min" | "max" {
  return size === "full" ? "max" : "min";
}

/**
 * The largest size with the video's aspect ratio that fits in box, with even
 * dimensions (the glasses' delta encoder works in 2-pixel rows and 4-pixel
 * columns) of at least 2. Upscales small videos too: the size is the
 * viewer's choice.
 */
export function fitVideo(video: Size, box: Size): Size {
  if (video.width <= 0 || video.height <= 0) return { width: evenFloor(box.width), height: evenFloor(box.height) };
  const scale = Math.min(box.width / video.width, box.height / video.height);
  return {
    width: evenFloor(Math.min(box.width, Math.round(video.width * scale))),
    height: evenFloor(Math.min(box.height, Math.round(video.height * scale))),
  };
}

/**
 * The video's rect within a viewport, centered. x snaps to a multiple of 4
 * and y to a multiple of 2 so frame deltas don't straddle an extra encoder
 * block at each edge.
 */
export function videoRect(size: VideoSize, video: Size, viewport: Size): Rect {
  const fixed = FIXED_BOXES[size];
  const box = fixed
    ? { width: Math.min(fixed.width, viewport.width), height: Math.min(fixed.height, viewport.height) }
    : viewport;
  const fitted = fitVideo(video, box);
  return {
    x: Math.max(0, Math.floor((viewport.width - fitted.width) / 8) * 4),
    y: Math.max(0, Math.floor((viewport.height - fitted.height) / 4) * 2),
    ...fitted,
  };
}

/** "3:52", or "1:02:03" past an hour. */
export function formatMediaTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}
