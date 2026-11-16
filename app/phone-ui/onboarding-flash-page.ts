import { NavigatedData, Page } from "@nativescript/core";

import { glassesTypeSetting } from "../ui/dashboard-settings";
import { G1FlashViewModel } from "./g1-flash-view-model";
import { FlashMode, OnboardingFlashViewModel } from "./onboarding-flash-view-model";

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    const context =
      (args.context as { mode?: FlashMode; fromOnboarding?: boolean; autoStart?: boolean } | undefined) ?? undefined;
    const options = {
      mode: context?.mode ?? "install",
      fromOnboarding: context?.fromOnboarding ?? true,
      autoStart: context?.autoStart ?? false,
    };
    page.bindingContext = glassesTypeSetting.get() === "g1" ? new G1FlashViewModel(options) : new OnboardingFlashViewModel(options);
  }
}

export function navigatingFrom(args: NavigatedData): void {
  const page = args.object as Page;
  (page.bindingContext as OnboardingFlashViewModel | G1FlashViewModel | undefined)?.dispose();
  page.bindingContext = null;
}
