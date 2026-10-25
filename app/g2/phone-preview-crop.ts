import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../graphics/image";
import { previewScalingSetting } from "../ui/dashboard-settings";
import { phonePreviewRect, usedScreenRect, type ScreenRect } from "../ui/shell/geometry";
import { shell } from "../ui/shell/shell";

/**
 * The screen area the phone's mirror shows (Settings > Phone display >
 * Preview scaling), or null for the whole panel. Scaled zooms to the
 * Glanceboard while it shows, else to the area the shell uses around the
 * foreground window, centred at the panel's aspect. A locked display gets
 * the whole panel: its message box is centred in the panel, not the band.
 */
export function phonePreviewCrop(locked: boolean, glanceRect: ScreenRect | null): ScreenRect | null {
  if (locked || previewScalingSetting.get() === "raw") return null;
  const window = shell.foregroundWindow();
  const crop = phonePreviewRect(glanceRect ?? usedScreenRect(window?.heightMode ?? "min", window?.appId));
  const wholePanel = crop.x === 0 && crop.y === 0 && crop.width === G2_LENS_WIDTH && crop.height === G2_LENS_HEIGHT;
  return wholePanel ? null : crop;
}

/**
 * A point on the mirror, as fractions of the mirror's width and height,
 * as fractions of the panel's, given the crop the mirror is showing.
 * Points in the black margins past the panel's edges come out below 0 or
 * above 1.
 */
export function mirrorToPanelFraction(crop: ScreenRect | null, nx: number, ny: number): { nx: number; ny: number } {
  if (!crop) return { nx, ny };
  return {
    nx: (crop.x + nx * crop.width) / G2_LENS_WIDTH,
    ny: (crop.y + ny * crop.height) / G2_LENS_HEIGHT,
  };
}
