import { type GlanceWidgetDefinition, type GlanceWidgetId } from "../widget";
import { CompassWidget } from "./compass-widget";
import { MusicWidget } from "./music-widget";
import { NightscoutWidget } from "./nightscout-widget";
import { SystemCardWidget } from "./system-card";

/** Every widget a board slot can hold. */
export const GLANCE_WIDGETS: readonly GlanceWidgetDefinition[] = [
  { id: "system-card", label: "System card", create: () => new SystemCardWidget() },
  { id: "nightscout", label: "Nightscout", create: () => new NightscoutWidget() },
  { id: "compass", label: "Compass", create: () => new CompassWidget() },
  { id: "music", label: "Music", create: () => new MusicWidget() },
];

export function findGlanceWidget(id: GlanceWidgetId | string): GlanceWidgetDefinition | null {
  return GLANCE_WIDGETS.find((widget) => widget.id === id) ?? null;
}
