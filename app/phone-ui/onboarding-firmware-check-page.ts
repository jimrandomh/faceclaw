import { EventData, Page } from "@nativescript/core";

import { OnboardingFirmwareCheckViewModel } from "./onboarding-firmware-check-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new OnboardingFirmwareCheckViewModel();
  }
}

export function navigatingFrom(args: EventData): void {
  const page = args.object as Page;
  (page.bindingContext as OnboardingFirmwareCheckViewModel | undefined)?.dispose();
  page.bindingContext = null;
}
