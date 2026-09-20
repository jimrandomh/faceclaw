import { Dialogs, Observable } from '@nativescript/core';
import {
  brightnessSetting, DISPLAY_MODE_VALUES, displayModeLabel, displayModeSetting,
  type BrightnessSetting, type DisplayModeSetting,
} from '../ui/dashboard-settings';

type ControlsTab = 'settings' | 'watch' | 'ring';
// Remember the tab across navigation on both platforms, without persisting it.
let lastControlsTab: ControlsTab = 'watch';

/** Shared state and actions for remote-controls.xml; transport stays in the host. */
export class RemoteControlsViewModel extends Observable {
  private _controlsTab: ControlsTab = lastControlsTab;

  get settingsTabVisibility(): "visible" | "collapse" {
    return this._controlsTab === "settings" ? "visible" : "collapse";
  }

  get watchTabVisibility(): "visible" | "collapse" {
    return this._controlsTab === "watch" ? "visible" : "collapse";
  }

  get ringTabVisibility(): "visible" | "collapse" {
    return this._controlsTab === "ring" ? "visible" : "collapse";
  }

  get settingsTabClass(): string {
    return this._controlsTab === "settings" ? "tab-button tab-button-selected" : "tab-button";
  }

  get watchTabClass(): string {
    return this._controlsTab === "watch" ? "tab-button tab-button-selected" : "tab-button";
  }

  get ringTabClass(): string {
    return this._controlsTab === "ring" ? "tab-button tab-button-selected" : "tab-button";
  }

  onSettingsTabTap(): void {
    this.setControlsTab("settings");
  }

  onWatchTabTap(): void {
    this.setControlsTab("watch");
  }

  onRingTabTap(): void {
    this.setControlsTab("ring");
  }

  protected setControlsTab(tab: ControlsTab): void {
    if (this._controlsTab === tab) return;
    this._controlsTab = tab;
    // Remembered across navigations (module-level) so the page comes back on
    // the tab it left on; deliberately not persisted to disk.
    lastControlsTab = tab;
    this.notifyPropertyChange("settingsTabVisibility", this.settingsTabVisibility);
    this.notifyPropertyChange("watchTabVisibility", this.watchTabVisibility);
    this.notifyPropertyChange("ringTabVisibility", this.ringTabVisibility);
    this.notifyPropertyChange("settingsTabClass", this.settingsTabClass);
    this.notifyPropertyChange("watchTabClass", this.watchTabClass);
    this.notifyPropertyChange("ringTabClass", this.ringTabClass);
  }

  // ---- display mode and brightness, on the Settings tab ----

  get displayModeLabel(): string {
    return displayModeLabel(displayModeSetting.get()) + " ▾";
  }

  async onDisplayModeTap(): Promise<void> {
    const current = displayModeSetting.get();
    const options = DISPLAY_MODE_VALUES.map((value) => displayModeLabel(value) + (value === current ? "  ✓" : ""));
    const picked = await Dialogs.action({ title: "Display mode", cancelButtonText: "Cancel", actions: options });
    const index = options.indexOf(picked);
    if (index < 0) return;
    const value = DISPLAY_MODE_VALUES[index] as DisplayModeSetting;
    if (value !== current) displayModeSetting.set(value);
    this.notifyPropertyChange("displayModeLabel", this.displayModeLabel);
  }

  get brightnessAuto(): boolean {
    return brightnessSetting.get() === "auto";
  }

  get brightnessSliderEnabled(): boolean {
    return !this.brightnessAuto;
  }

  /** The slider's position; while Auto, the last manual level (or 50). */
  get brightnessPercent(): number {
    const value = brightnessSetting.get();
    if (value === "auto") return this.lastManualBrightness;
    const numeric = parseInt(value, 10);
    return Number.isFinite(numeric) ? numeric : 50;
  }

  private lastManualBrightness = 50;

  onBrightnessChange(args: { value?: number; object?: { value?: number } }): void {
    if (this.brightnessAuto) return;
    const raw = typeof args.value === "number" ? args.value : Number(args.object?.value ?? NaN);
    if (!Number.isFinite(raw)) return;
    // The setting only has every tenth level; snap to the nearest.
    const level = Math.min(100, Math.max(0, Math.round(raw / 10) * 10));
    this.lastManualBrightness = level;
    const value = String(level) as BrightnessSetting;
    if (brightnessSetting.get() !== value) brightnessSetting.set(value);
  }

  onBrightnessAutoChange(args: { value?: boolean; object?: { checked?: boolean } }): void {
    const on = typeof args.value === "boolean" ? args.value : Boolean(args.object?.checked);
    if (on) {
      if (brightnessSetting.get() !== "auto") {
        this.lastManualBrightness = this.brightnessPercent;
        brightnessSetting.set("auto");
      }
    } else if (brightnessSetting.get() === "auto") {
      brightnessSetting.set(String(this.lastManualBrightness) as BrightnessSetting);
    }
    this.refreshDisplayControls();
  }

  public refreshDisplayControls(): void {
    this.notifyPropertyChange("brightnessAuto", this.brightnessAuto);
    this.notifyPropertyChange("brightnessSliderEnabled", this.brightnessSliderEnabled);
    this.notifyPropertyChange("brightnessPercent", this.brightnessPercent);
    this.notifyPropertyChange("displayModeLabel", this.displayModeLabel);
  }

}
