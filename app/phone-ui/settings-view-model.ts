import { Dialogs, Frame, Observable } from '@nativescript/core';
import {
  brightnessSetting,
  displayLayoutSetting,
  glassesModelName,
  onAnySettingChanged,
  phoneInputStyleSetting,
  type BrightnessSetting,
  type PhoneInputStyle,
} from '../ui/dashboard-settings';
import { formatBatteryLine } from '../g2/glasses-display-state';
import { getGlassesPresence, onGlassesPresenceChanged } from '../g2/glasses-presence';
import { shell } from '../ui/shell/shell';

/** What each input style's touchpad does, under the Phone input style row. */
const INPUT_STYLE_HINTS: Record<PhoneInputStyle, string> = {
  watch: "Like the watch remote: swipes navigate, tap selects, double-tap or two fingers goes back, a hold opens the menu.",
  ring: "Like the R1's touch strip: vertical swipes scroll; tap, double-tap and hold are click, double-click and long-press.",
};

/**
 * The phone's settings page (settings-page.xml), opened by the gear button
 * under the mirror: display mode, brightness, the main page's input style and
 * battery levels. Shared by Android and iOS: everything it shows comes from
 * the settings store, the shell's battery levels and the glasses-presence
 * module, which both platforms' controllers feed, so it needs no host.
 */
export class SettingsViewModel extends Observable {
  private readonly unsubscribers: Array<() => void> = [];
  private _batteryLine = "";
  private lastManualBrightness = 50;

  /**
   * Subscribe while the page is on screen (its `loaded`) and catch up on
   * whatever changed while it wasn't. Idempotent.
   */
  attach(): void {
    if (this.unsubscribers.length > 0) return;
    this.unsubscribers.push(
      // Every row can also change from the glasses' Settings app.
      onAnySettingChanged(() => this.refreshSettings()),
      shell.onBatteryLevelsChanged(() => this.refreshBatteryLine()),
      onGlassesPresenceChanged(() => this.refreshBatteryLine()),
    );
    this.refreshSettings();
    this.refreshBatteryLine();
  }

  /** The page's `unloaded`. */
  detach(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  onBackTap(): void {
    Frame.topmost()?.goBack();
  }

  private refreshSettings(): void {
    this.notifyPropertyChange("displayModeLabel", this.displayModeLabel);
    this.notifyPropertyChange("brightnessAuto", this.brightnessAuto);
    this.notifyPropertyChange("brightnessSliderEnabled", this.brightnessSliderEnabled);
    this.notifyPropertyChange("brightnessPercent", this.brightnessPercent);
    this.notifyPropertyChange("watchStyleClass", this.watchStyleClass);
    this.notifyPropertyChange("ringStyleClass", this.ringStyleClass);
    this.notifyPropertyChange("phoneInputStyleHint", this.phoneInputStyleHint);
  }

  // ---- display mode ----

  get displayModeLabel(): string {
    return displayLayoutSetting.displayValue() + " ▾";
  }

  async onDisplayModeTap(): Promise<void> {
    const current = displayLayoutSetting.get();
    // Full Screen is offered only with a bottom or popup app switcher.
    const values = displayLayoutSetting.values.filter((value) => !displayLayoutSetting.isDisabled(value));
    const options = values.map((value) => displayLayoutSetting.displayValue(value) + (value === current ? "  ✓" : ""));
    const picked = await Dialogs.action({ title: "Display mode", cancelButtonText: "Cancel", actions: options });
    const index = options.indexOf(picked);
    if (index < 0) return;
    const value = values[index]!;
    if (value !== current) displayLayoutSetting.set(value);
    this.notifyPropertyChange("displayModeLabel", this.displayModeLabel);
  }

  // ---- brightness ----

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

  onBrightnessChange(args: { value?: number; object?: { value?: number } }): void {
    if (this.brightnessAuto) return;
    const raw = typeof args.value === "number" ? args.value : Number(args.object?.value ?? NaN);
    if (!Number.isFinite(raw)) return;
    // The setting only has every tenth level; snap to the nearest.
    const level = Math.min(100, Math.max(2, Math.round(raw / 10) * 10));
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
    this.notifyPropertyChange("brightnessAuto", this.brightnessAuto);
    this.notifyPropertyChange("brightnessSliderEnabled", this.brightnessSliderEnabled);
    this.notifyPropertyChange("brightnessPercent", this.brightnessPercent);
  }

  // ---- phone input style: which touchpad the main page shows ----

  get watchStyleClass(): string {
    return segmentClass(phoneInputStyleSetting.get() === "watch");
  }

  get ringStyleClass(): string {
    return segmentClass(phoneInputStyleSetting.get() === "ring");
  }

  get phoneInputStyleHint(): string {
    return INPUT_STYLE_HINTS[phoneInputStyleSetting.get()];
  }

  onWatchStyleTap(): void {
    this.setPhoneInputStyle("watch");
  }

  onRingStyleTap(): void {
    this.setPhoneInputStyle("ring");
  }

  private setPhoneInputStyle(style: PhoneInputStyle): void {
    if (phoneInputStyleSetting.get() === style) return;
    phoneInputStyleSetting.set(style);
    // The store's own change notification arrives a tick later; don't leave
    // the buttons showing the old choice until then.
    this.notifyPropertyChange("watchStyleClass", this.watchStyleClass);
    this.notifyPropertyChange("ringStyleClass", this.ringStyleClass);
    this.notifyPropertyChange("phoneInputStyleHint", this.phoneInputStyleHint);
  }

  // ---- battery levels ----

  /**
   * Last-known levels of the glasses, their charging case and the R1
   * (formatBatteryLine), or "" (the row is then hidden) while none is known.
   */
  get batteryLine(): string {
    return this._batteryLine;
  }

  get batteryLineVisibility(): "visible" | "collapse" {
    return this._batteryLine ? "visible" : "collapse";
  }

  private refreshBatteryLine(): void {
    // "connected" covers a charging session too, on both platforms.
    const line = formatBatteryLine(shell.getBatteryLevels(), getGlassesPresence().connected, glassesModelName());
    if (line === this._batteryLine) return;
    this._batteryLine = line;
    this.notifyPropertyChange("batteryLine", line);
    this.notifyPropertyChange("batteryLineVisibility", this.batteryLineVisibility);
  }
}

function segmentClass(selected: boolean): string {
  return selected ? "segment-button segment-button-selected" : "segment-button";
}
