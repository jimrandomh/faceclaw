import { Frame, Observable, Screen } from "@nativescript/core";
import { glassesTypeSetting, type GlassesType } from "../ui/dashboard-settings";

import { isPreviewOnlyMode } from "./onboarding-state";

/** Steps are separate pages in the flow; the devices page follows the splash. */
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

type Makers = { product: string; maker: string; makerPossessive: string };

const GLASSES_MAKER: Record<GlassesType, Makers> = {
  g1: { product: "Even Realities G1", maker: "Even Realities", makerPossessive: "Even's" },
  g2: { product: "Even Realities G2", maker: "Even Realities", makerPossessive: "Even's" },
  "rayneo-io": { product: "RayNeo iO", maker: "RayNeo", makerPossessive: "RayNeo's" },
};

/** Preview Only: no particular glasses yet, so the disclaimer covers every kind Faceclaw supports. */
const ANY_GLASSES_MAKER: Makers = { product: "Even Realities G1 and G2 and RayNeo iO", maker: "Even Realities or RayNeo", makerPossessive: "their" };

const WARRANTY_NOTE = "Installing custom firmware is not covered by warranty.";
// Preview Only is chosen on Your Devices, which is three pages back from here.
const PREVIEW_HINT = "Not ready? Go back to Your Devices and choose Preview Only to explore Faceclaw on your phone's screen instead.";

function firmwareBody(glasses: GlassesType): string {
  // Pairing skips the firmware pages for an iO: the app has no flasher for it.
  if (glasses === "rayneo-io") {
    return `Faceclaw only runs on a RayNeo iO that has Faceclaw's custom firmware installed. This app can't install it on an iO, so that has to be done separately before you pair your glasses. ${WARRANTY_NOTE}\n\n${PREVIEW_HINT}`;
  }
  const restore = glasses === "g1"
    ? "Returning to the official firmware later takes a computer."
    : "You can uninstall and return to the official firmware later, by reconnecting the official Even Realities app.";
  return `Faceclaw only runs on ${GLASSES_MAKER[glasses].product} glasses that have Faceclaw's custom firmware installed. Next, Faceclaw will pair with your glasses, check their firmware, and install the custom firmware if it isn't there yet.\n\nFlashing replaces the official firmware. ${restore} ${WARRANTY_NOTE}\n\n${PREVIEW_HINT}`;
}

function stepContent(step: OnboardingStep, glasses: GlassesType, previewOnly: boolean): StepContent {
  const { product, maker, makerPossessive } = previewOnly ? ANY_GLASSES_MAKER : GLASSES_MAKER[glasses];
  switch (step) {
    case 1:
      return {
        headline: "Faceclaw",
        tagline: "Perching on the faces of giants",
        body: "",
        primaryLabel: "Next",
        secondaryLabel: "",
        splash: true,
        showSecondary: false,
      };
    case 2:
      return {
        headline: "Before You Continue",
        tagline: "",
        body: `This software provides a custom user interface and functionality for the ${product} smart glasses. It is not created or supported by ${maker}. If this software somehow breaks your headset, this is not ${makerPossessive} fault and is not covered by the hardware's warranty. If this software doesn't break your headset, using this software may void the hardware's warranty anyways, at the sole discretion of ${maker}. This software is beta; don't rely on it for anything critically important.`,
        primaryLabel: "Agree",
        secondaryLabel: "Back",
        splash: false,
        showSecondary: true,
      };
    case 3:
      return {
        headline: "Custom Firmware Required",
        tagline: "",
        body: firmwareBody(glasses),
        primaryLabel: glasses === "rayneo-io" ? "Pair Glasses" : "Flash Firmware",
        secondaryLabel: "Back",
        splash: false,
        showSecondary: true,
      };
  }
}

export class OnboardingViewModel extends Observable {
  private readonly step: OnboardingStep;
  private readonly content: StepContent;

  constructor(initialStep?: number) {
    super();
    this.step = initialStep === 2 || initialStep === 3 ? initialStep : 1;
    this.content = stepContent(this.step, glassesTypeSetting.get(), isPreviewOnlyMode());
  }

  onPrimaryTap(): void {
    if (this.step === 1) {
      Frame.topmost()?.navigate({ moduleName: "phone-ui/onboarding-devices-page" });
      return;
    }
    if (this.step === 2) {
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

  /** Back, on the disclaimer and firmware steps. */
  onSecondaryTap(): void {
    const frame = Frame.topmost();
    if (frame?.canGoBack()) {
      frame.goBack();
      return;
    }
    // The disconnect page's Back can open step 3 on a fresh history.
    frame?.navigate({ moduleName: "phone-ui/onboarding-devices-page", clearHistory: true });
  }

  get headline(): string {
    return this.content.headline;
  }

  get tagline(): string {
    return this.content.tagline;
  }

  get body(): string {
    return this.content.body;
  }

  get primaryLabel(): string {
    return this.content.primaryLabel;
  }

  get secondaryLabel(): string {
    return this.content.secondaryLabel;
  }

  get showSecondary(): boolean {
    return this.content.showSecondary;
  }

  get splashVisibility(): "visible" | "collapse" {
    return this.content.splash ? "visible" : "collapse";
  }

  get contentVisibility(): "visible" | "collapse" {
    return this.content.splash ? "collapse" : "visible";
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
    return this.step === 2 ? "visible" : "collapse";
  }
}
