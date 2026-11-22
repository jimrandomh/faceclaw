import { Frame, Observable, type ImageSource } from '@nativescript/core';
import { phoneInputStyleSetting, type PhoneInputStyle } from '../ui/dashboard-settings';
import type { PhoneUiButton } from '../apps/evenhub/manager';
import type { GlassesPadStatus } from '../g2/glasses-display-state';

/** Shared state and actions for remote-controls.xml; transport stays in the host. */
export class RemoteControlsViewModel extends Observable {
  // The pad on screen. Cached so a settings-store change only notifies (and the
  // host only cancels gestures in flight) when the style really changed.
  private _inputStyle: PhoneInputStyle = phoneInputStyleSetting.get();
  private _evenHubPhoneUi: PhoneUiButton | null = null;
  private _padStatus: GlassesPadStatus = { label: "", asleep: false, detail: "" };

  // ---- which touchpad is showing (Settings > Phone input style) ----

  get watchPadVisibility(): "visible" | "collapse" {
    return this._inputStyle === "watch" ? "visible" : "collapse";
  }

  get ringPadVisibility(): "visible" | "collapse" {
    return this._inputStyle === "ring" ? "visible" : "collapse";
  }

  /** Re-read the input style; the host calls this when any setting changes (it can change from the glasses too). */
  public refreshInputStyle(): void {
    const style = phoneInputStyleSetting.get();
    if (style === this._inputStyle) return;
    this._inputStyle = style;
    this.notifyPropertyChange("watchPadVisibility", this.watchPadVisibility);
    this.notifyPropertyChange("ringPadVisibility", this.ringPadVisibility);
  }

  // ---- the watch face's status lines ----

  /**
   * What the watch face shows, from glassesPadStatus (the same on both
   * platforms). The host calls this whenever it may have changed: a session or
   * display-state change, or a gesture that moved the foreground.
   */
  public setPadStatus(status: GlassesPadStatus): void {
    const previous = this._padStatus;
    this._padStatus = status;
    if (status.label !== previous.label) this.notifyPropertyChange("padFocusLine", this.padFocusLine);
    if (status.asleep !== previous.asleep) {
      this.notifyPropertyChange("padFocusClass", this.padFocusClass);
      this.notifyPropertyChange("padWakeHintVisibility", this.padWakeHintVisibility);
    }
    if (status.detail !== previous.detail) {
      this.notifyPropertyChange("padDetailLine", this.padDetailLine);
      this.notifyPropertyChange("padDetailVisibility", this.padDetailVisibility);
    }
  }

  /** What the next gesture lands on: the foreground window's title, or why there is none ("Display off"). */
  get padFocusLine(): string {
    return this._padStatus.label;
  }

  /** "Display off" is dimmed like the dark screen it describes. */
  get padFocusClass(): string {
    return this._padStatus.asleep ? "pad-focus pad-focus-asleep" : "pad-focus";
  }

  /** The wake gesture, shown under "Display off". */
  get padWakeHintVisibility(): "visible" | "collapse" {
    return this._padStatus.asleep ? "visible" : "collapse";
  }

  /**
   * A smaller line under the watch face's status line, or "" to hide it: the
   * charging case's level while the glasses charge in it.
   */
  get padDetailLine(): string {
    return this._padStatus.detail;
  }

  get padDetailVisibility(): "visible" | "collapse" {
    return this.padDetailLine ? "visible" : "collapse";
  }

  // ---- the button bar: EvenHub phone UI, voice, keyboard, settings ----
  //
  // The mic and keyboard buttons (onSyntheticMicTap, onKeyboardTap) are the
  // host's: they go straight to its transport.

  /** Host hook: overlay this EvenHub app's phone UI over the main page. */
  showEvenHubPhoneUi: (windowId: string) => void = () => {};

  /**
   * The foreground glasses window's phone-UI button (phoneUiButton), or null
   * when it isn't an EvenHub app or its phone UI is already showing; set by
   * the host.
   */
  get evenHubPhoneUi(): PhoneUiButton | null {
    return this._evenHubPhoneUi;
  }

  set evenHubPhoneUi(value: PhoneUiButton | null) {
    const current = this._evenHubPhoneUi;
    if (current?.windowId === value?.windowId && current?.icon === value?.icon && current?.title === value?.title) return;
    this._evenHubPhoneUi = value;
    this.notifyPropertyChange("evenHubPhoneUiIcon", this.evenHubPhoneUiIcon);
    this.notifyPropertyChange("evenHubPhoneUiVisibility", this.evenHubPhoneUiVisibility);
    this.notifyPropertyChange("evenHubPhoneUiLabel", this.evenHubPhoneUiLabel);
  }

  /** The app's own icon (white on transparent; the stylesheet tints it like the other buttons'). */
  get evenHubPhoneUiIcon(): ImageSource | null {
    return this._evenHubPhoneUi?.icon ?? null;
  }

  get evenHubPhoneUiVisibility(): "visible" | "collapse" {
    return this._evenHubPhoneUi?.icon ? "visible" : "collapse";
  }

  /** The button's accessibility label. */
  get evenHubPhoneUiLabel(): string {
    return this._evenHubPhoneUi ? `Open ${this._evenHubPhoneUi.title} on phone` : "";
  }

  onEvenHubPhoneUiTap(): void {
    // Gated on the icon like the button's visibility, so a hidden button does nothing.
    const button = this._evenHubPhoneUi;
    if (button?.icon) this.showEvenHubPhoneUi(button.windowId);
  }

  /** The gear button: display mode, brightness, battery levels and the input style. */
  onSettingsTap(): void {
    Frame.topmost()?.navigate({ moduleName: "phone-ui/settings-page" });
  }
}
