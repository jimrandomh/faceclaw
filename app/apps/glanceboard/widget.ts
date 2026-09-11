import { type GrayImage } from "../../graphics/image";

/**
 * A Glanceboard widget: a small self-contained view that paints into a slot
 * of the board. Widgets are sized by the layout (the first layout is four
 * 288x144 quadrants) and own their data subscriptions and any hardware they
 * need between start and stop, so a board that is not showing costs nothing.
 *
 * Layouts are expected to be swapped out and iterated on; widgets are the
 * stable part, so keep them independent of any particular board geometry
 * beyond the slot size they are handed.
 */
export interface GlanceWidget {
  /**
   * The board became visible (or this widget was added to a visible board):
   * subscribe to data, start timers, enable hardware. `requestRender` asks
   * the board to repaint when something changed.
   */
  start(requestRender: () => void): void;
  /** Undo start. Called once for every start; must be safe to call twice. */
  stop(): void;
  /**
   * Paint the widget into `image`, a fresh 0-filled canvas of the slot's
   * size. Deferred draws (text, drawImage) are welcome and keep the cheap
   * texture-cache wire path.
   */
  paint(image: GrayImage): void;
}

export type GlanceWidgetId = "system-card" | "nightscout" | "compass" | "music" | "calendar" | "terminal";

export type GlanceWidgetDefinition = {
  id: GlanceWidgetId;
  /** Picker label in the Glanceboard app. */
  label: string;
  /**
   * The widget can fill two vertically adjacent slots as one double-height
   * region (chosen for both left or both right quadrants). Its paint then
   * gets the taller canvas; the divider between the slots is not drawn.
   */
  tall?: boolean;
  create: () => GlanceWidget;
};
