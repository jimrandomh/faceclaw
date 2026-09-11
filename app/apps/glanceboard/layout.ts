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

/** Whether two slots stack vertically with matching width (one region if merged). */
export function slotsVerticallyAdjacent(layout: GlanceLayout, a: number, b: number): boolean {
  const first = layout.slots[a]?.rect;
  const second = layout.slots[b]?.rect;
  if (!first || !second || a === b) return false;
  if (first.x !== second.x || first.width !== second.width) return false;
  return first.y + first.height === second.y || second.y + second.height === first.y;
}

/** A painted area of the board: one slot, or two vertically adjacent slots merged. */
export type GlanceRegion = {
  /** The slot choice (widget id) filling the region. */
  choice: string;
  rect: GlanceSlotRect;
  /** Indices into layout.slots, ascending. */
  slots: number[];
};

/**
 * Turn per-slot choices into regions. A widget chosen for two vertically
 * adjacent slots, when `canSpan` says it supports it, becomes one
 * double-height region; every other non-empty slot is a region of its own
 * (a duplicate that cannot merge simply paints twice). Regions come out in
 * slot order.
 */
export function resolveGlanceRegions(
  layout: GlanceLayout,
  choices: readonly string[],
  canSpan: (choice: string) => boolean,
): GlanceRegion[] {
  const regions: GlanceRegion[] = [];
  const consumed = new Set<number>();
  layout.slots.forEach((slot, index) => {
    if (consumed.has(index)) return;
    const choice = choices[index] ?? "none";
    if (choice === "none") return;
    consumed.add(index);
    let rect = { ...slot.rect };
    const slots = [index];
    if (canSpan(choice)) {
      const partner = layout.slots.findIndex(
        (_, other) => !consumed.has(other) && choices[other] === choice && slotsVerticallyAdjacent(layout, index, other),
      );
      if (partner >= 0) {
        consumed.add(partner);
        slots.push(partner);
        const other = layout.slots[partner]!.rect;
        const top = Math.min(rect.y, other.y);
        rect = { x: rect.x, y: top, width: rect.width, height: Math.max(rect.y + rect.height, other.y + other.height) - top };
      }
    }
    regions.push({ choice, rect, slots });
  });
  return regions;
}

/** A divider line between slots, in board coordinates (inclusive endpoints). */
export type GlanceDivider = { x0: number; y0: number; x1: number; y1: number };

/**
 * The hairlines between slots: every slot's left edge (when not at the
 * board's left) and top edge (when not at the top), except the top edge of
 * the lower slot of a merged double-height region, which is that region's
 * interior. Shared by the board painter and the config app's preview.
 */
export function slotDividers(layout: GlanceLayout, regions: readonly GlanceRegion[]): GlanceDivider[] {
  const dividers: GlanceDivider[] = [];
  layout.slots.forEach(({ rect }, index) => {
    if (rect.x > 0) dividers.push({ x0: rect.x, y0: rect.y, x1: rect.x, y1: rect.y + rect.height - 1 });
    if (rect.y === 0) return;
    const interior = regions.some(
      (region) => region.slots.length > 1 && region.slots.includes(index) && region.rect.y < rect.y,
    );
    if (!interior) dividers.push({ x0: rect.x, y0: rect.y, x1: rect.x + rect.width - 1, y1: rect.y });
  });
  return dividers;
}
