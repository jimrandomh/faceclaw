import { NavigatedData, Page } from "@nativescript/core";

import { OnboardingViewModel } from "./onboarding-view-model";

type OnboardingContext = { step?: number } | undefined;

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  // Preserve the step when returning from the flashing page (back navigation
  // re-fires navigatingTo); only build a fresh model on first entry. The
  // permissions page navigates here with { step: 3 } to continue the flow.
  if (!page.bindingContext) {
    const context = args.context as OnboardingContext;
    page.bindingContext = new OnboardingViewModel(context?.step);
  }
}
