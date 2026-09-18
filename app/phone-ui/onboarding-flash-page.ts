import { NavigatedData, Page } from "@nativescript/core";

import { FlashMode, OnboardingFlashViewModel } from "./onboarding-flash-view-model";

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    const context =
      (args.context as { mode?: FlashMode; fromOnboarding?: boolean; autoStart?: boolean } | undefined) ?? undefined;
    page.bindingContext = new OnboardingFlashViewModel({
      mode: context?.mode ?? "install",
      fromOnboarding: context?.fromOnboarding ?? true,
      autoStart: context?.autoStart ?? false,
    });
  }
}
