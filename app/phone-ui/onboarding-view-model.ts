import { Frame, Observable, Screen } from "@nativescript/core";

import { setOnboardingCompleted, setPreviewOnlyMode } from "./onboarding-state";

type OnboardingStep = 1 | 2 | 3;

type StepContent = {
  headline: string;
  tagline: string;
  body: string;
  primaryLabel: string;
  secondaryLabel: string;
  /** Step 1 renders as the vertically-centered splash (headline + tagline + logo) instead of the scrolling body. */
  splash: boolean;
  showSecondary: boolean;
};

const STEP_CONTENT: Record<OnboardingStep, StepContent> = {
  1: {
    headline: "Faceclaw",
    tagline: "Perching on the faces of giants",
    body: "",
    primaryLabel: "Next",
    secondaryLabel: "",
    splash: true,
    showSecondary: false,
  },
  2: {
    headline: "Before You Continue",
    tagline: "",
    body:
      "This unofficial software provides a custom user interface and functionality for the Even Realities G2 smart glasses. It is not created or supported by Even Realities. If this software somehow breaks my headset, this is not Even's fault and is not covered by the hardware's warranty. If this software doesn't break my headset, using this software may void the hardware's warranty anyways, at the sole discretion of Even Realities. This software is a development prototype and may not be relied on for anything important. This software may be broken at any time by software or firmware updates created by Even, and this will not be Even's fault.",
    primaryLabel: "Agree",
    secondaryLabel: "Back",
    splash: false,
    showSecondary: true,
  },
  3: {
    headline: "Custom Firmware Required",
    tagline: "",
    body:
      "Faceclaw only runs on Even Realities G2 glasses that have Faceclaw's custom firmware installed. You have two choices:\n\n• Preview Only — explore Faceclaw's interface on your phone's screen without pairing any glasses. Nothing is written to a headset.\n\n• Flash Firmware — install the custom firmware on your glasses now, then use Faceclaw for real. Faceclaw scans for nearby glasses so you can pick yours by model, colour, and serial, then connects, asks for confirmation on the lens, and downloads and prepares the firmware.\n\nFlashing replaces the official firmware. It may void your warranty and, like any firmware update, carries a risk of bricking the device. The glasses can only be connected to one app at a time, so the next step will walk you through disconnecting the official Even app (and any other glasses apps) first.",
    primaryLabel: "Flash Firmware",
    secondaryLabel: "Preview Only",
    splash: false,
    showSecondary: true,
  },
};

export class OnboardingViewModel extends Observable {
  private _step: OnboardingStep = 1;

  constructor(initialStep?: number) {
    super();
    if (initialStep === 2 || initialStep === 3) this._step = initialStep;
    this.publish();
  }

  onPrimaryTap(): void {
    if (this._step === 1) {
      this.setStep(2);
      return;
    }
    if (this._step === 2) {
      // The Permissions screen sits between the disclaimer and the firmware
      // step; it navigates forward to a fresh onboarding page at step 3.
      Frame.topmost()?.navigate({
        moduleName: "phone-ui/permissions-page",
        context: { onboarding: true },
      });
      return;
    }
    // Step 3 primary: begin the flashing setup — disconnect other glasses apps
    // first (a connected app blocks our BLE access, including pairing), then
    // scan for and pick the glasses (manual address entry is offered from that
    // page), then check firmware and flash.
    Frame.topmost()?.navigate({ moduleName: "phone-ui/onboarding-unpair-page" });
  }

  onLicenseTap(): void {
    this.openDocument("LICENSE", "License (GPLv3)");
  }

  onPrivacyTap(): void {
    this.openDocument("PRIVACY", "Privacy Policy");
  }

  private openDocument(fileName: string, title: string): void {
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/document-page",
      context: { fileName, title },
    });
  }

  onSecondaryTap(): void {
    if (this._step === 2) {
      this.setStep(1);
      return;
    }
    if (this._step === 3) {
      // Step 3 secondary: skip flashing, use the on-phone preview only.
      setPreviewOnlyMode(true);
      setOnboardingCompleted(true);
      Frame.topmost()?.navigate({
        moduleName: "phone-ui/main-page",
        clearHistory: true,
      });
    }
  }

  get headline(): string {
    return STEP_CONTENT[this._step].headline;
  }

  get tagline(): string {
    return STEP_CONTENT[this._step].tagline;
  }

  get body(): string {
    return STEP_CONTENT[this._step].body;
  }

  get primaryLabel(): string {
    return STEP_CONTENT[this._step].primaryLabel;
  }

  get secondaryLabel(): string {
    return STEP_CONTENT[this._step].secondaryLabel;
  }

  get showSecondary(): boolean {
    return STEP_CONTENT[this._step].showSecondary;
  }

  get splashVisibility(): "visible" | "collapse" {
    return STEP_CONTENT[this._step].splash ? "visible" : "collapse";
  }

  get contentVisibility(): "visible" | "collapse" {
    return STEP_CONTENT[this._step].splash ? "collapse" : "visible";
  }

  /**
   * The logo scales with the screen (~40% of its height) so it reads as a
   * splash on tablets too, capped near the source PNG's height so it doesn't
   * upscale into mush.
   */
  get logoHeight(): number {
    return Math.min(480, Math.round(Screen.mainScreen.heightDIPs * 0.4));
  }

  get secondaryVisibility(): "visible" | "collapse" {
    return this.showSecondary ? "visible" : "collapse";
  }

  /** License and privacy-policy links, shown only under the disclaimer step. */
  get footerVisibility(): "visible" | "collapse" {
    return this._step === 2 ? "visible" : "collapse";
  }

  private setStep(step: OnboardingStep): void {
    if (this._step === step) return;
    this._step = step;
    this.publish();
  }

  private publish(): void {
    this.notifyPropertyChange("headline", this.headline);
    this.notifyPropertyChange("tagline", this.tagline);
    this.notifyPropertyChange("body", this.body);
    this.notifyPropertyChange("primaryLabel", this.primaryLabel);
    this.notifyPropertyChange("secondaryLabel", this.secondaryLabel);
    this.notifyPropertyChange("showSecondary", this.showSecondary);
    this.notifyPropertyChange("splashVisibility", this.splashVisibility);
    this.notifyPropertyChange("contentVisibility", this.contentVisibility);
    this.notifyPropertyChange("secondaryVisibility", this.secondaryVisibility);
    this.notifyPropertyChange("footerVisibility", this.footerVisibility);
  }
}
