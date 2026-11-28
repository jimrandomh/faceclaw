import { EventData, Frame, Observable, View } from "@nativescript/core";

import { glassesTypeSetting, type GlassesType } from "../ui/dashboard-settings";
import { watchAppInstall } from "../native/watch-app-install";
import {
  ownsNeuralBand, ownsRing, ownsWatch, setOwnsNeuralBand, setOwnsRing, setOwnsWatch, setPreviewOnlyMode,
} from "./onboarding-state";
import { isNeuralBandAvailable } from "../native/neural-band";
import { openWatchAppInstall, watchAppPrompt, type WatchAppPrompt } from "./watch-app-prompt";

/** A row in the glasses list: a kind of glasses, or no glasses at all. */
type GlassesChoice = GlassesType | "preview";

const GLASSES_OPTIONS: { choice: GlassesChoice; label: string; description?: string }[] = [
  { choice: "preview", label: "Preview Only", description: "No glasses: explore Faceclaw on your phone's screen" },
  { choice: "g1", label: "Even G1" },
  { choice: "g2", label: "Even G2" },
  { choice: "rayneo-io", label: "RayNeo iO" },
];

/** RayNeo iO support isn't ready to offer in a release yet; set this to show its row again. */
const OFFER_RAYNEO_IO = false;

/** Why this choice can't be made on this phone, or "" when it can. */
function unavailableReason(choice: GlassesChoice): string {
  // FaceclawCommunicatorBridge refuses to start a session with one on iOS.
  return choice === "rayneo-io" && global.isIOS ? "Not supported on iOS yet" : "";
}

export type GlassesOptionItem = {
  choice: GlassesChoice;
  label: string;
  selectable: boolean;
  note: string;
  noteVisibility: "visible" | "collapse";
  rowClass: string;
  /** Hidden, not collapsed: the check is what sets a row's height, so collapsing it would shift the list on every selection. */
  checkVisibility: "visible" | "hidden";
  onRowTap: (args: EventData) => void;
};

/**
 * The Your Devices onboarding page, between the splash and the disclaimer: one
 * kind of glasses (or Preview Only) plus any accessories, which later setup
 * pages tailor themselves to. Pairing still has the last word on the glasses,
 * since it can tell what it heard.
 *
 * Nothing starts out selected, whatever an earlier run stored, and Next waits
 * for a choice. A tap stores it straight away: Preview Only sets the persisted
 * preview-only flag and leaves the glasses type alone, so the Permissions page
 * finishes onboarding instead of moving on to the firmware step.
 *
 * Saying you have an Apple Watch also offers to install the watch app, while
 * the paired watch lacks it (watch-app-prompt.ts).
 */
export class OnboardingDevicesViewModel extends Observable {
  /** This visit's choice; the page keeps this model when you come Back to it. */
  private selected: GlassesChoice | null = null;
  private watchApp: WatchAppPrompt = watchAppPrompt();
  private stopWatchingWatchApp: (() => void) | null = null;

  /** The page's `loaded`, which also follows a return from installing the watch app. Idempotent. */
  attach(): void {
    this.stopWatchingWatchApp ??= watchAppInstall.onStateChanged(() => this.refreshWatchApp());
    this.refreshWatchApp();
  }

  /** The page's `unloaded`. */
  detach(): void {
    this.stopWatchingWatchApp?.();
    this.stopWatchingWatchApp = null;
  }

  get glassesOptions(): GlassesOptionItem[] {
    const selected = this.selected;
    const options = OFFER_RAYNEO_IO ? GLASSES_OPTIONS : GLASSES_OPTIONS.filter(({ choice }) => choice !== "rayneo-io");
    return options.map(({ choice, label, description }) => {
      const reason = unavailableReason(choice);
      const note = reason || description || "";
      const isSelected = choice === selected;
      return {
        choice,
        label,
        selectable: !reason,
        note,
        noteVisibility: note ? "visible" : "collapse",
        rowClass: isSelected ? "pairing-row pairing-row-selected" : reason ? "pairing-row pairing-row-incomplete" : "pairing-row",
        checkVisibility: isSelected ? "visible" : "hidden",
        onRowTap: this.onGlassesRowTap,
      };
    });
  }

  // Arrow property: NativeScript fires XML event handlers with `this` bound to
  // the tapped view's bindingContext (the row item), not the view model.
  readonly onGlassesRowTap = (args: EventData): void => {
    const item = (args.object as View).bindingContext as GlassesOptionItem | undefined;
    if (!item?.selectable) return;
    this.selected = item.choice;
    setPreviewOnlyMode(item.choice === "preview");
    if (item.choice !== "preview") glassesTypeSetting.set(item.choice);
    this.notifyPropertyChange("glassesOptions", this.glassesOptions);
    this.notifyPropertyChange("nextEnabled", this.nextEnabled);
  };

  get nextEnabled(): boolean {
    return this.selected !== null;
  }

  get hasRing(): boolean {
    return ownsRing();
  }

  set hasRing(value: boolean) {
    setOwnsRing(value);
  }

  get hasWatch(): boolean {
    return ownsWatch();
  }

  set hasWatch(value: boolean) {
    setOwnsWatch(value);
    this.notifyWatchApp();
  }

  get watchLabel(): string {
    return global.isIOS ? "Apple Watch" : "Wear OS watch";
  }

  get neuralBandVisibility(): "visible" | "collapse" {
    return isNeuralBandAvailable() ? "visible" : "collapse";
  }

  get hasNeuralBand(): boolean {
    return isNeuralBandAvailable() && ownsNeuralBand();
  }

  set hasNeuralBand(value: boolean) {
    if (isNeuralBandAvailable()) setOwnsNeuralBand(value);
  }

  // ---- installing the watch app, under the watch switch while it's on ----

  /** "Installed", or how to install; nothing while the switch is off or no watch is paired. */
  get watchAppNote(): string {
    if (!ownsWatch() || !this.watchApp.visible) return "";
    return this.watchApp.installed ? "Faceclaw is installed on your watch." : this.watchApp.hint;
  }

  get watchAppNoteVisibility(): "visible" | "collapse" {
    return this.watchAppNote ? "visible" : "collapse";
  }

  get watchAppInstallVisibility(): "visible" | "collapse" {
    return ownsWatch() && this.watchApp.canInstall ? "visible" : "collapse";
  }

  onWatchAppInstallTap(): void {
    void openWatchAppInstall();
  }

  private refreshWatchApp(): void {
    this.watchApp = watchAppPrompt();
    this.notifyWatchApp();
  }

  private notifyWatchApp(): void {
    this.notifyPropertyChange("watchAppNote", this.watchAppNote);
    this.notifyPropertyChange("watchAppNoteVisibility", this.watchAppNoteVisibility);
    this.notifyPropertyChange("watchAppInstallVisibility", this.watchAppInstallVisibility);
  }

  onNextTap(): void {
    if (!this.nextEnabled) return;
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/onboarding-page",
      context: { step: this.hasNeuralBand ? "neural-band" : 2 },
    });
  }

  onBackTap(): void {
    const frame = Frame.topmost();
    if (frame?.canGoBack()) {
      frame.goBack();
      return;
    }
    frame?.navigate({ moduleName: "phone-ui/onboarding-page", clearHistory: true });
  }
}
