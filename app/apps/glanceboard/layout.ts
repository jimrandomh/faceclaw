/**
 * Board geometry. A layout names its slots and places them on the board;
 * the Glanceboard app's slot pickers and the board renderer are both driven
 * by it, so a replacement layout (different slot count, sizes, positions) is
 * a matter of swapping this object out and reusing the same widgets.
 */
export const GLANCEBOARD_WIDTH = 576;
export const GLANCEBOARD_HEIGHT = 288;

export type GlanceSlotRect = { x: number; y: number; width: number; height: number };

export type GlanceLayout = {
  id: string;
  width: number;
  height: number;
  slots: readonly { label: string; rect: GlanceSlotRect }[];
};

/** The first layout: four equal quadrants, each 288x144. */
export const QUADRANT_LAYOUT: GlanceLayout = {
  id: "quadrants",
  width: GLANCEBOARD_WIDTH,
  height: GLANCEBOARD_HEIGHT,
  slots: [
    { label: "Top left", rect: { x: 0, y: 0, width: 288, height: 144 } },
    { label: "Top right", rect: { x: 288, y: 0, width: 288, height: 144 } },
    { label: "Bottom left", rect: { x: 0, y: 144, width: 288, height: 144 } },
    { label: "Bottom right", rect: { x: 288, y: 144, width: 288, height: 144 } },
  ],
};
