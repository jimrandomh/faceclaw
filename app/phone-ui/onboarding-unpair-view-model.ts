import { Frame, Observable, Screen } from "@nativescript/core";

import { openEvenAppSettings } from "../native/even-app-conflict";

export class OnboardingUnpairViewModel extends Observable {
  onOpenEvenAppSettingsTap(): void {
    openEvenAppSettings();
  }

  onContinueTap(): void {
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/pairing-page",
      context: { onboarding: true },
    });
  }

  onBackTap(): void {
    const frame = Frame.topmost();
    if (frame?.canGoBack()) {
      frame.goBack();
      return;
    }
    frame?.navigate({
      moduleName: "phone-ui/onboarding-page",
      context: { step: 3 },
      clearHistory: true,
    });
  }

  /**
   * The settings button fills the page's width on phones but is capped so it
   * doesn't stretch edge-to-edge on tablets.
   */
  get settingsButtonWidth(): number {
    return Math.min(320, Math.round(Screen.mainScreen.widthDIPs) - 40);
  }
}
