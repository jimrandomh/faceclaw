import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../../graphics/image";
import {
  appSwitcherPositionSetting,
  type AppSwitcherPosition,
  displayLayoutSetting,
  type DisplayLayout,
  navigateDisplayLayoutSetting,
  terminalDisplayLayoutSetting,
  statusBarPositionSetting,
  statusBarVisibilitySetting,
  uiDepthSetting,
  windowBorderSetting,
} from "../dashboard-settings";

/** Top bar: 24px notification icons plus a little padding. */
export const TOP_BAR_HEIGHT = 28;
/**
 * Width of the sidebar strip as painted (the app switcher on the left or
 * right edge). App windows get the other 576px — the surface width EvenHub
 * apps expect — and keep that width with the switcher at the bottom or a
 * popup too, except in the Full Screen display mode (640 wide; never beside
 * a strip) and immersive windows, which the switcher overlays (see
 * sidebarWidth). Icon column layout within the strip (one wide column vs.
 * two narrow ones) is the chrome layer's business.
 */
export const SIDEBAR_WIDTH = 64;

/**
 * Height of one row of the app switcher under the window: one tall tab, the
 * same 36px (a 32px icon plus 2px either side) as a one-column sidebar slot.
 * The row is wide enough that it never needs the sidebar's smaller
 * two-column icons. It comes out of the height available to windows; their
 * width stays 576, centred, leaving SIDEBAR_WIDTH / 2 at each side: one
 * pixel for the side of the window's frame (windowFramed), the rest for the
 * whole display's stereo shift (uiDepth). Full Screen windows take those
 * margins too, giving up both. When the row's contents don't fit, the
 * switcher grows a second row (see setSwitcherBarHeight).
 */
export const SWITCHER_ROW_HEIGHT = 36;

/**
 * Height of the bottom switcher as its contents last laid out (chrome-layer.ts
 * planBottomBar): SWITCHER_ROW_HEIGHT, or more once the status bar's items
 * or the window icons take a second row. One for the switcher reserved
 * under windows, one for the switcher overlaying an immersive window.
 */
const switcherBarHeights = { reserved: SWITCHER_ROW_HEIGHT, overlay: SWITCHER_ROW_HEIGHT };

/**
 * Set the bottom switcher's height for its current layout under the given
 * (foreground) app's window: the overlay's over an immersive window, else
 * the row reserved under windows. True if that moves or resizes windows.
 */
export function setSwitcherBarHeight(height: number, appId?: string): boolean {
  const which = isImmersive(appId) ? "overlay" : "reserved";
  if (switcherBarHeights[which] === height) return false;
  switcherBarHeights[which] = height;
  return which === "reserved";
}

/** Which edge the app switcher is on, or a popup (Settings > Customization). */
export function switcherPosition(): AppSwitcherPosition {
  return appSwitcherPositionSetting.get();
}

/** Whether the app switcher is a strip down the left or right edge. */
function sideStrip(): boolean {
  const position = switcherPosition();
  return position === "left" || position === "right";
}

/** An app's own Display mode setting (Navigate, Terminal); "default" for the rest. */
function appDisplayLayout(appId?: string) {
  return appId === "navigate" ? navigateDisplayLayoutSetting.get()
    : appId === "terminal" ? terminalDisplayLayoutSetting.get() : "default";
}

/**
 * The display mode an app's windows use (see dashboard-settings.ts
 * DisplayLayout): its own, or the global one. Full Screen needs the width a
 * side strip takes, so beside one it is Tall.
 */
export function displayLayout(appId?: string): DisplayLayout {
  const own = appDisplayLayout(appId);
  const layout = own === "global" || own === "default" ? displayLayoutSetting.get() : own;
  return layout === "fullscreen" && sideStrip() ? "tall" : layout;
}

/** Fraction of the slack above a window band in each band display mode. */
const BAND_FRACTIONS: Partial<Record<DisplayLayout, number>> = {
  "band-top": 0,
  "band-high": 0.25,
  "band-middle": 0.5,
  "band-low": 0.75,
  "band-bottom": 1,
};

/** A band display mode's fraction of the slack above the band; undefined for Tall and Full Screen. */
function bandFraction(layout: DisplayLayout): number | undefined {
  return BAND_FRACTIONS[layout];
}

/**
 * Apps whose windows are immersive right now: the whole panel, with no
 * status bar, window frame or room kept for the switcher (which overlays
 * them only while it has focus), at depth 0. An app switches it at runtime
 * (InProcessWindow.setImmersive; the onboarding's first pages), so it is
 * per app, like the per-app display modes.
 */
const immersiveApps = new Set<string>();

/** Mark an app's windows immersive or not; true if that changed anything. */
export function setAppImmersive(appId: string, immersive: boolean): boolean {
  if (immersiveApps.has(appId) === immersive) return false;
  if (immersive) immersiveApps.add(appId);
  else immersiveApps.delete(appId);
  return true;
}

export function isImmersive(appId?: string): boolean {
  return appId !== undefined && immersiveApps.has(appId);
}

/** Whether an app's windows span the panel's whole width: Full Screen, or immersive. */
function fullWidth(appId?: string): boolean {
  return isImmersive(appId) || displayLayout(appId) === "fullscreen";
}

/**
 * How much of the screen's width the sidebar takes away from app windows:
 * the strip, or nothing when the switcher is a bottom row or a popup or the
 * window is immersive (where the chrome paints the strip over the window
 * while the sidebar has focus).
 */
export function sidebarWidth(appId?: string): number {
  return !isImmersive(appId) && sideStrip() ? SIDEBAR_WIDTH : 0;
}

/**
 * How much of the screen's height a bottom switcher takes away from app
 * windows: its rows (one, or two when the layout needs them), or nothing
 * beside a side strip or under an immersive window (where the switcher
 * overlays the window's bottom edge while it has focus).
 */
export function switcherRowHeight(appId?: string): number {
  return !isImmersive(appId) && switcherPosition() === "bottom" ? switcherBarHeights.reserved : 0;
}

/**
 * Whether the switcher is on screen: always when it reserves room; as a
 * popup, or over an immersive window, only while it has focus.
 */
export function sidebarStripVisible(focus: "sidebar" | "window", appId?: string): boolean {
  return (!isImmersive(appId) && switcherPosition() !== "popup") || focus === "sidebar";
}

/**
 * Screen rect of the switcher strip. A side strip aligns to the min-height
 * band (like the shell overlays). A bottom row sits right under the given
 * (foreground) window and spans its width, so a band shorter than the
 * screen has no gap below it; it moves when the foreground switches to a
 * window of another height, as the top bar does. Over an immersive window
 * the row overlays the bottom edge of the screen. Either way it is as tall
 * as its layout (setSwitcherBarHeight). A popup's is the area it centres
 * in, the foreground window's content (the chrome layer sizes the box
 * itself).
 */
export function switcherRect(heightMode: WindowHeightMode, appId?: string): { x: number; y: number; width: number; height: number } {
  switch (switcherPosition()) {
    case "popup":
      return appViewportRect(heightMode, appId);
    case "bottom": {
      const reserved = switcherRowHeight(appId);
      const height = reserved || switcherBarHeights.overlay;
      return {
        x: appViewportLeft(appId),
        y: reserved > 0 ? windowTop(heightMode, appId) + windowBandHeight(heightMode, appId) : G2_LENS_HEIGHT - height,
        width: appViewportWidth(appId),
        height,
      };
    }
    case "right":
      return { x: G2_LENS_WIDTH - SIDEBAR_WIDTH, y: minWindowTop(appId), width: SIDEBAR_WIDTH, height: MIN_WINDOW_HEIGHT };
    default:
      return { x: 0, y: minWindowTop(appId), width: SIDEBAR_WIDTH, height: MIN_WINDOW_HEIGHT };
  }
}

/**
 * Whether the foreground window's content gets a rounded frame (drawn by
 * the chrome layer). Its left and right sides take the pixel just outside
 * the 576-wide window; there's no room around a Full Screen or immersive
 * window, nor need beside a side strip. With a reserved bottom switcher row
 * it otherwise always has one: the row's top edge is the frame's bottom side, as the window
 * header's last row is its top. With a popup switcher it's the Window
 * border setting's choice, and its top and bottom take a header or footer
 * row of their own, except where the status bar's row next to the window
 * serves.
 */
export function windowFramed(appId?: string): boolean {
  switch (switcherPosition()) {
    case "bottom":
      return switcherRowHeight(appId) > 0 && !fullWidth(appId);
    case "popup":
      return !fullWidth(appId) && windowBorderSetting.get();
    default:
      return false;
  }
}

/**
 * Whether the status bar shares the bottom switcher row instead of topping
 * each window (Settings > Customization > Status bar position): only beside
 * a reserved row, as the row over an immersive window shows just while it
 * has focus.
 */
export function statusInSwitcherRow(appId?: string): boolean {
  return switcherRowHeight(appId) > 0 && statusBarPositionSetting.get() === "bottom";
}

/**
 * Which edge of the foreground window's band the status bar runs along
 * (outside the switcher row): the top, or, with a popup switcher, the
 * bottom too (Settings > Customization > Status bar position).
 */
export function statusBarEdge(): "top" | "bottom" {
  return switcherPosition() === "popup" && statusBarPositionSetting.get() === "bottom" ? "bottom" : "top";
}

/**
 * Whether the status bar shows only while a popup switcher is up, over the
 * edge of the window's content, rather than always in rows of the band's
 * own (Settings > Customization > Status bar visibility).
 */
export function statusBarOverlays(): boolean {
  return switcherPosition() === "popup" && statusBarVisibilitySetting.get() === "switcher";
}

/**
 * Rows the shell draws along one edge of each window's content: the status
 * bar's (the top bar, as a header), the frame's side, or none. A bottom
 * switcher row's band has no footer: the frame's bottom side is the row's
 * top edge. An immersive window has neither.
 */
function windowEdgeHeight(edge: "top" | "bottom", appId?: string): number {
  if (isImmersive(appId)) return 0;
  if (switcherPosition() !== "popup") {
    if (edge === "bottom") return 0;
    return !statusInSwitcherRow(appId) ? TOP_BAR_HEIGHT : windowFramed(appId) ? 1 : 0;
  }
  if (!statusBarOverlays() && statusBarEdge() === edge) return TOP_BAR_HEIGHT;
  return windowFramed(appId) ? 1 : 0;
}

/**
 * Height of the header the shell draws over each window's content: the top
 * bar; with the status bar elsewhere, just the row the window frame's top
 * runs along, or nothing without a frame.
 */
export function windowHeaderHeight(appId?: string): number {
  return windowEdgeHeight("top", appId);
}

/**
 * Height of the footer the shell draws under each window's content, within
 * its band: with a popup switcher, the status bar at the bottom, or the row
 * the window frame's bottom runs along; else nothing.
 */
export function windowFooterHeight(appId?: string): number {
  return windowEdgeHeight("bottom", appId);
}

/**
 * Top edge (y) of the status bar's TOP_BAR_HEIGHT rows for a window: the
 * band's first rows, or its last with the status bar at the bottom. Over
 * the content when the status bar overlays (statusBarOverlays).
 */
export function statusBarTop(heightMode: WindowHeightMode, appId?: string): number {
  const top = windowTop(heightMode, appId);
  return statusBarEdge() === "bottom" ? top + windowBandHeight(heightMode, appId) - TOP_BAR_HEIGHT : top;
}

/**
 * Whether a screen point lies on the switcher's side of the screen, for
 * touches on the phone's mirror: anywhere in a side strip's column, or from
 * the top of a bottom row (under the given foreground window) down. A popup
 * is modal: while it shows, the whole screen is the switcher's.
 */
export function isOnSwitcherEdge(x: number, y: number, heightMode: WindowHeightMode, appId?: string): boolean {
  switch (switcherPosition()) {
    case "popup":
      return true;
    case "bottom":
      return y >= switcherRect(heightMode, appId).y;
    case "right":
      return x >= G2_LENS_WIDTH - SIDEBAR_WIDTH;
    default:
      return x < SIDEBAR_WIDTH;
  }
}

/** Width of app windows: the panel's when Full Screen or immersive, else 576 (see SIDEBAR_WIDTH). */
function appViewportWidth(appId?: string): number {
  return fullWidth(appId) ? G2_LENS_WIDTH : G2_LENS_WIDTH - SIDEBAR_WIDTH;
}

/**
 * Left edge (x) of app windows: past a left strip, centred above a bottom
 * row (see SWITCHER_ROW_HEIGHT) or under a popup switcher, else the screen
 * edge.
 */
export function appViewportLeft(appId?: string): number {
  if (fullWidth(appId)) return 0;
  switch (switcherPosition()) {
    case "left":
      return SIDEBAR_WIDTH;
    case "bottom":
    case "popup":
      return SIDEBAR_WIDTH / 2;
    default:
      return 0;
  }
}

/**
 * Stereo depth of the whole display (Settings > Customization > Depth), in
 * the firmware's depth units; the shell scene carries it to the compositor,
 * which shifts the screen and everything drawn over it per lens. Only with
 * the switcher at the bottom or a popup, where the windows' side margins,
 * less the window frame's pixel, leave room for the shift; not while the
 * given (foreground) app's windows are Full Screen or immersive, which have
 * no margins.
 */
export function uiDepth(appId?: string): number {
  return sideStrip() || fullWidth(appId) ? 0 : Number(uiDepthSetting.get());
}

/**
 * In a band display mode, explicit app modes (including Use global) replace
 * the requested height; the default keeps legacy per-window heights, such
 * as tall terminal sessions. Tall, Full Screen and immersive windows are
 * always the whole height.
 */
export function effectiveHeightMode(mode: WindowHeightMode, appId?: string): WindowHeightMode {
  if (isImmersive(appId) || bandFraction(displayLayout(appId)) === undefined) return "max";
  return appDisplayLayout(appId) === "default" ? mode : "min";
}

/**
 * X of the display's true horizontal centre, in app-viewport coordinates. A
 * side strip pushes the viewport off centre, so UI the wearer physically
 * aims with — a compass rose, a calibration crosshair — has to offset by it
 * rather than use the viewport's own centre.
 */
export function screenCenterInViewportX(): number {
  return Math.round(G2_LENS_WIDTH / 2) - appViewportLeft();
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
 * header (and footer) taller, so the content area between them is a full
 * 288px (the EvenHub app surface height); "max" uses the whole 480px screen
 * (terminal views), less a bottom switcher's rows. All include the header the
 * shell draws at the window's top edge (windowHeaderHeight) and any footer
 * at its bottom (windowFooterHeight).
 */
export type WindowHeightMode = "min" | "medium" | "max";

/** Total height (header + content) of a min-height window. */
export const MIN_WINDOW_HEIGHT = 288;

/**
 * Height of the screen area windows are placed in: the whole screen, less
 * a bottom switcher's height.
 */
function windowAreaHeight(appId?: string): number {
  return G2_LENS_HEIGHT - switcherRowHeight(appId);
}

/** Total height (header + content + footer) of a window's band in the given mode. */
export function windowBandHeight(mode: WindowHeightMode, appId?: string): number {
  switch (effectiveHeightMode(mode, appId)) {
    case "max":
      return windowAreaHeight(appId);
    case "medium":
      return MIN_WINDOW_HEIGHT + windowHeaderHeight(appId) + windowFooterHeight(appId);
    default:
      return MIN_WINDOW_HEIGHT;
  }
}

/**
 * Fraction of the slack above a window band, from the band display mode's
 * position: each band height distributes its own free space by the same
 * fraction, so all heights sit consistently within the screen. Tall and
 * Full Screen windows leave no slack.
 */
function verticalPositionFraction(appId?: string): number {
  return bandFraction(displayLayout(appId)) ?? 0.5;
}

/**
 * Top edge (y) of a min-height window. The sidebar and shell overlays always
 * align to this band, even while a taller window is foreground.
 */
export function minWindowTop(appId?: string): number {
  return windowTop("min", appId);
}

/**
 * Top edge (y) of a window's header; max-height windows pin to the screen
 * top. A bottom switcher row hangs under the band, so the band and a
 * one-row switcher together distribute the screen's slack. A switcher of
 * more rows takes its extra height out of the slack under it, pushing the
 * band up only as far as there is too little, so the band doesn't move as
 * the switcher's layout changes unless it has to.
 */
export function windowTop(mode: WindowHeightMode, appId?: string): number {
  const band = windowBandHeight(mode, appId);
  const oneRowArea = G2_LENS_HEIGHT - (switcherRowHeight(appId) > 0 ? SWITCHER_ROW_HEIGHT : 0);
  const top = Math.round((oneRowArea - band) * verticalPositionFraction(appId));
  return Math.min(top, windowAreaHeight(appId) - band);
}

/** App-content viewport size for a height mode (independent of vertical position). */
export function appViewportSize(mode: WindowHeightMode, appId?: string): { width: number; height: number } {
  return {
    width: appViewportWidth(appId),
    height: windowBandHeight(mode, appId) - windowHeaderHeight(appId) - windowFooterHeight(appId),
  };
}

/** Screen rect of a window's app-content viewport (between its header and footer). */
export function appViewportRect(mode: WindowHeightMode, appId?: string): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: appViewportLeft(appId),
    y: windowTop(mode, appId) + windowHeaderHeight(appId),
    ...appViewportSize(mode, appId),
  };
}

export type ScreenRect = { x: number; y: number; width: number; height: number };

function unionRect(a: ScreenRect, b: ScreenRect): ScreenRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * The part of the screen the shell draws in while the given (foreground)
 * window is up: the window's band, plus the frame's side pixels; the
 * min-height band the shell overlays align to; and a side strip or bottom
 * row (a popup shows within the window's content). An immersive window has
 * the whole panel. The phone mirror's Scaled preview zooms to this.
 */
export function usedScreenRect(heightMode: WindowHeightMode, appId?: string): ScreenRect {
  if (isImmersive(appId)) return { x: 0, y: 0, width: G2_LENS_WIDTH, height: G2_LENS_HEIGHT };
  const frame = windowFramed(appId) ? 1 : 0;
  const x = appViewportLeft(appId) - frame;
  const width = appViewportWidth(appId) + 2 * frame;
  let used = unionRect(
    { x, y: windowTop(heightMode, appId), width, height: windowBandHeight(heightMode, appId) },
    { x, y: minWindowTop(appId), width, height: MIN_WINDOW_HEIGHT },
  );
  if (switcherPosition() !== "popup") used = unionRect(used, switcherRect(heightMode, appId));
  return used;
}

/**
 * The screen area the phone mirror shows to present `used` as large as it
 * fits, centred, at the panel's own 4:3 aspect (so the mirror keeps its
 * shape whatever the display mode): `used` grown along one axis, past the
 * panel's edges if need be (the mirror shows black there).
 */
export function phonePreviewRect(used: ScreenRect): ScreenRect {
  // Whole 4:3 units, so the aspect is exact.
  const units = Math.ceil(Math.max(used.width / 4, used.height / 3));
  const width = units * 4;
  const height = units * 3;
  return {
    x: Math.round(used.x + (used.width - width) / 2),
    y: Math.round(used.y + (used.height - height) / 2),
    width,
    height,
  };
}
