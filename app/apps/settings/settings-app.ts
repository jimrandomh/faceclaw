import { type Plane } from "../../graphics/plane";
import { LayerActions } from "../../ui/layers";
import { EditTextSettingLayer } from "../../ui/dashboard-settings";
import { createSettingsPanelLayer } from "../../ui/dashboard/settings-menus";
import { SettingsDescriptionOverlayLayer } from "../../ui/dashboard/settings-panel";
import { createInProcessWindow, type InProcessWindow } from "../../ui/shell/in-process-window";
import { type ShellWindow } from "../../ui/shell/shell";

export const SETTINGS_WINDOW_ID = "settings";
export const SETTINGS_SURFACE_ID = "window:settings";

export type SettingsAppOptions = {
  actions: LayerActions;
  submitFrame: (planes: Plane[], paintMs: number, frameId: number) => Promise<void>;
  setSurfaceVisible: (visible: boolean) => void;
  removeSurface: () => void;
  onClosed: () => void;
};

export type SettingsAppWindow = {
  window: ShellWindow;
  /** The full in-process window record, for hosts that manage window lifecycle. */
  inProcess: InProcessWindow;
  requestRender: () => void;
  /** Select a section in the left column by label (e.g. "Terminal"). */
  focusSection: (label: string) => void;
  /** Whether the glasses-side text-setting editor is the top layer. */
  isTextEditorOnTop: () => boolean;
  /** Pop the text-setting editor if it is on top; returns whether it was. */
  closeTextEditor: () => boolean;
};

/**
 * The Settings app: the settings menu tree (previously a dashboard submenu)
 * hosted in its own in-process window. In-process because the text-setting
 * editor is synchronized with the phone-side TextField through the
 * controller, which lives on the main thread.
 */
export function createSettingsAppWindow(options: SettingsAppOptions): SettingsAppWindow {
  const panel = createSettingsPanelLayer();
  const inProcess = createInProcessWindow({
    appId: "settings",
    windowId: SETTINGS_WINDOW_ID,
    title: "Settings",
    iconLetter: "Se",
    icon: "settings",
    closeable: true,
    actions: options.actions,
    // Not wrapped in YieldAtRootLayer: the panel routes double-click itself
    // (right column -> left column, then left column -> sidebar).
    baseLayer: panel,
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
  const { window, stack, requestRender } = inProcess;
  // The help-text band draws as its own plane so it can partially occlude
  // list rows (a plane's raster covers lower planes' glyphs); it forwards
  // input to the panel, so the stack behaves as if the panel were on top.
  stack.push(new SettingsDescriptionOverlayLayer(panel));
  return {
    window,
    inProcess,
    requestRender,
    focusSection: (label) => {
      panel.focusSection(label);
      requestRender();
    },
    isTextEditorOnTop: () => stack.topMatches((layer) => layer instanceof EditTextSettingLayer),
    closeTextEditor: () => stack.popIfTop((layer) => layer instanceof EditTextSettingLayer),
  };
}
