import { Frame, Observable } from "@nativescript/core";

import { setOnboardingCompleted } from "./onboarding-state";

type OnboardingStep = 1 | 2 | 3;

type StepContent = {
  headline: string;
  tagline: string;
  body: string;
  primaryLabel: string;
  secondaryLabel: string;
  showLogo: boolean;
  showTagline: boolean;
  showSecondary: boolean;
};

const STEP_CONTENT: Record<OnboardingStep, StepContent> = {
  1: {
    headline: "Faceclaw",
    tagline: "Perching on the faces of giants",
    body: "",
    primaryLabel: "Next",
    secondaryLabel: "",
    showLogo: true,
    showTagline: true,
    showSecondary: false,
  },
  2: {
    headline: "Before You Continue",
    tagline: "",
    body:
      "This unofficial software provides a custom user interface and functionality for the Even Realities G2 smart glasses. It is not created or supported by Even Realities. If this software somehow breaks my headset, this is not Even's fault and is not covered by the hardware's warranty. If this software doesn't break my headset, using this software may void the hardware's warranty anyways, at the sole discretion of Even Realities. This software is a development prototype and may not be relied on for anything important. This software may be broken at any time by software or firmware updates created by Even, and this will not be Even's fault.",
    primaryLabel: "Agree",
    secondaryLabel: "Back",
    showLogo: false,
    showTagline: false,
    showSecondary: true,
  },
  3: {
    headline: "Disconnect Even First",
    tagline: "",
    body:
      "You can switch back and forth between Faceclaw and the official Even Realities application at any time. However, they can't both be connected to the headset simultaneously. The Even app will reconnect to the glasses whenever you launch it. To disconnect the official Even app, open it, go to the Home tab, select your glasses, open the Connection submenu, and press Disconnect.",
    primaryLabel: "Configure",
    secondaryLabel: "Back",
    showLogo: false,
    showTagline: false,
    showSecondary: true,
  },
};

export class OnboardingViewModel extends Observable {
  private _step: OnboardingStep = 1;

  constructor() {
    super();
    this.publish();
  }

  onPrimaryTap(): void {
    if (this._step === 1) {
      this.setStep(2);
      return;
    }
    if (this._step === 2) {
      this.setStep(3);
      return;
    }
    setOnboardingCompleted(true);
    Frame.topmost()?.navigate({
      moduleName: "config-page",
      clearHistory: true,
    });
  }

  onSecondaryTap(): void {
    if (this._step === 2) {
      this.setStep(1);
      return;
    }
    if (this._step === 3) {
      this.setStep(2);
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

  get showLogo(): boolean {
    return STEP_CONTENT[this._step].showLogo;
  }

  get showTagline(): boolean {
    return STEP_CONTENT[this._step].showTagline;
  }

  get showSecondary(): boolean {
    return STEP_CONTENT[this._step].showSecondary;
  }

  get logoVisibility(): "visible" | "collapse" {
    return this.showLogo ? "visible" : "collapse";
  }

  get taglineVisibility(): "visible" | "collapse" {
    return this.showTagline ? "visible" : "collapse";
  }

  get secondaryVisibility(): "visible" | "collapse" {
    return this.showSecondary ? "visible" : "collapse";
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
    this.notifyPropertyChange("showLogo", this.showLogo);
    this.notifyPropertyChange("showTagline", this.showTagline);
    this.notifyPropertyChange("showSecondary", this.showSecondary);
    this.notifyPropertyChange("logoVisibility", this.logoVisibility);
    this.notifyPropertyChange("taglineVisibility", this.taglineVisibility);
    this.notifyPropertyChange("secondaryVisibility", this.secondaryVisibility);
  }
}
