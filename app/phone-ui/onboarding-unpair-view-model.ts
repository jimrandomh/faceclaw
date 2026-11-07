import { Frame, Observable, Screen } from "@nativescript/core";

import { openEvenAppSettings } from "../native/even-app-conflict";
import { glassesTypeSetting } from "../ui/dashboard-settings";
import { hasCompletedOnboarding } from "./onboarding-state";

export class OnboardingUnpairViewModel extends Observable {
  /**
   * Setting up a RayNeo iO, so the Even app doesn't apply. Only during first-run
   * setup: "Pair glasses" in the main menu also opens this page, and you may be
   * pairing something other than the glasses you paired before.
   */
  private readonly settingUpIo = !hasCompletedOnboarding() && glassesTypeSetting.get() === "rayneo-io";

  get otherAppsInstructions(): string {
    const apps = this.settingUpIo ? "another app" : "another app (such as Even Realities or MentraOS)";
    return `Your glasses can only be connected to one app or phone at a time. If they're connected to ${apps} or another phone, disconnect them there before continuing. If nothing else is connected, you can continue.`;
  }

  get evenAppVisibility(): "visible" | "collapse" {
    return this.settingUpIo ? "collapse" : "visible";
  }

  get settingsButtonVisibility(): "visible" | "collapse" {
    return global.isAndroid && !this.settingUpIo ? "visible" : "collapse";
  }

  get evenAppInstructions(): string {
    return "If you use the Even Realities app, go to Home, select your glasses, open the Connection submenu, and press Disconnect" +
      (global.isIOS ? "." : " (or disable the Even app's \"nearby devices\" permission).");
  }

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
