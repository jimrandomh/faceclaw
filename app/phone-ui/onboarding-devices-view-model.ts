import { EventData, Frame, Observable, View } from "@nativescript/core";

import { glassesTypeSetting, type GlassesType } from "../ui/dashboard-settings";
import { isPreviewOnlyMode, ownsRing, ownsWatch, setOwnsRing, setOwnsWatch, setPreviewOnlyMode } from "./onboarding-state";

/** A row in the glasses list: a kind of glasses, or no glasses at all. */
type GlassesChoice = GlassesType | "preview";

const GLASSES_OPTIONS: { choice: GlassesChoice; label: string; description?: string }[] = [
  { choice: "g1", label: "Even G1" },
  { choice: "g2", label: "Even G2" },
  { choice: "rayneo-io", label: "RayNeo iO" },
  { choice: "preview", label: "Preview Only", description: "No glasses: explore Faceclaw on your phone's screen" },
];

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
 * Preview Only is the persisted preview-only flag, and leaves the glasses type
 * alone; the Permissions page then finishes onboarding instead of moving on to
 * the firmware step.
 */
export class OnboardingDevicesViewModel extends Observable {
  get glassesOptions(): GlassesOptionItem[] {
    const selected: GlassesChoice = isPreviewOnlyMode() ? "preview" : glassesTypeSetting.get();
    return GLASSES_OPTIONS.map(({ choice, label, description }) => {
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
    setPreviewOnlyMode(item.choice === "preview");
    if (item.choice !== "preview") glassesTypeSetting.set(item.choice);
    this.notifyPropertyChange("glassesOptions", this.glassesOptions);
  };

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
  }

  get watchLabel(): string {
    return global.isIOS ? "Apple Watch" : "Wear OS watch";
  }

  onNextTap(): void {
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/onboarding-page",
      context: { step: 2 },
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
