import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../../graphics/image";
import {
  displayModeSetting,
  type DisplayModeSetting,
  verticalPositionSetting,
  navigateDisplayModeSetting,
  navigateVerticalPositionSetting,
  terminalDisplayModeSetting,
  terminalVerticalPositionSetting,
} from "../dashboard-settings";

/** Top bar: 24px notification icons plus a little padding. */
export const TOP_BAR_HEIGHT = 28;
/**
 * Width of the sidebar strip as painted. Leaves the app viewport exactly
 * 576px wide — the surface width EvenHub apps expect — except in the
 * full-panel display mode, where the strip overlays the app (see
 * sidebarWidth). Icon column layout within the strip (one wide column vs.
 * two narrow ones) is the chrome layer's business.
 */
export const SIDEBAR_WIDTH = 64;

/** The Display > Display mode setting (see dashboard-settings.ts). */
function appDisplayMode(appId?: string) {
  return appId === "navigate" ? navigateDisplayModeSetting.get()
    : appId === "terminal" ? terminalDisplayModeSetting.get() : "default";
}

export function displayMode(appId?: string): DisplayModeSetting {
  const mode = appDisplayMode(appId);
  return mode === "global" || mode === "default" ? displayModeSetting.get() : mode;
}

/**
 * How much of the screen's width the sidebar takes away from app windows:
 * the strip, or nothing in the full-panel mode (where the chrome paints the
 * strip over the window while the sidebar has focus).
 */
export function sidebarWidth(appId?: string): number {
  return displayMode(appId) === "640x480" ? 0 : SIDEBAR_WIDTH;
}

/**
 * Whether the sidebar strip is on screen: always when it reserves width; in
 * the full-panel mode (where it overlays the window) only while it has focus.
 */
export function sidebarStripVisible(focus: "sidebar" | "window", appId?: string): boolean {
  return sidebarWidth(appId) > 0 || focus === "sidebar";
}

/**
 * Explicit app sizes (including Use global) replace the requested height.
 * The default keeps legacy per-window heights, such as tall terminal sessions.
 */
export function effectiveHeightMode(mode: WindowHeightMode, appId?: string): WindowHeightMode {
  return displayMode(appId) === "576x288" ? (appDisplayMode(appId) === "default" ? mode : "min") : "max";
}

/**
 * X of the display's true horizontal centre, in app-viewport coordinates. The
 * sidebar pushes the viewport to the right, so UI the wearer physically aims
 * with — a compass rose, a calibration crosshair — has to offset by it rather
 * than use the viewport's own centre.
 */
export function screenCenterInViewportX(): number {
  return Math.round(G2_LENS_WIDTH / 2) - sidebarWidth();
}

/**
 * On the color-key shell surface, pixel value 0 is transparent; 1 is the
 * darkest opaque shade (identical to 0 after 4bpp quantization). Shell
 * painting must use this for intentional black.
 */
export const SHELL_OPAQUE_BLACK = 1;

/**
 * Windows come in three heights. "min" covers the same 288px band the stock
 * firmware uses, leaving most of the field of view clear; "medium" is one
 * top bar taller, so the content area below the bar is a full 288px (the
 * EvenHub app surface height); "max" uses the whole 480px screen (terminal
 * views). All include a top bar drawn by the shell at the window's top edge.
 */
export type WindowHeightMode = "min" | "medium" | "max";

/** Total height (top bar + content) of a min-height window. */
export const MIN_WINDOW_HEIGHT = 288;
/** Farthest down a min-height window can start. */
export const MIN_WINDOW_MAX_TOP = G2_LENS_HEIGHT - MIN_WINDOW_HEIGHT;

/** Total height (top bar + content) of a window's band in the given mode. */
export function windowBandHeight(mode: WindowHeightMode, appId?: string): number {
  switch (effectiveHeightMode(mode, appId)) {
    case "max":
      return G2_LENS_HEIGHT;
    case "medium":
      return MIN_WINDOW_HEIGHT + TOP_BAR_HEIGHT;
    default:
      return MIN_WINDOW_HEIGHT;
  }
}

/**
 * Fraction of the slack above a window band, from the Display > Vertical
 * position setting: each band height distributes its own free space by the
 * same fraction, so all heights sit consistently within the screen.
 */
function verticalPositionFraction(appId?: string): number {
  const position = appId === "navigate" ? navigateVerticalPositionSetting.get()
    : appId === "terminal" ? terminalVerticalPositionSetting.get() : "global";
  switch (position === "global" ? verticalPositionSetting.get() : position) {
    case "top":
      return 0;
    case "upper":
      return 0.25;
    case "lower":
      return 0.75;
    case "bottom":
      return 1;
    default:
      return 0.5;
  }
}

/**
 * Top edge (y) of a min-height window. The sidebar and shell overlays always
 * align to this band, even while a taller window is foreground.
 */
export function minWindowTop(appId?: string): number {
  return windowTop("min", appId);
}

/** Top edge (y) of a window's top bar; max-height windows pin to the screen top. */
export function windowTop(mode: WindowHeightMode, appId?: string): number {
  return Math.round((G2_LENS_HEIGHT - windowBandHeight(mode, appId)) * verticalPositionFraction(appId));
}

/** App-content viewport size for a height mode (independent of vertical position). */
export function appViewportSize(mode: WindowHeightMode, appId?: string): { width: number; height: number } {
  return {
    width: G2_LENS_WIDTH - sidebarWidth(appId),
    height: windowBandHeight(mode, appId) - TOP_BAR_HEIGHT,
  };
}

/** Screen rect of a window's app-content viewport (below its top bar). */
export function appViewportRect(mode: WindowHeightMode, appId?: string): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: sidebarWidth(appId),
    y: windowTop(mode, appId) + TOP_BAR_HEIGHT,
    ...appViewportSize(mode, appId),
  };
}
