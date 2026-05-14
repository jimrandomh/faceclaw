import { EventData, Page } from "@nativescript/core";

import { OnboardingViewModel } from "./onboarding-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  page.bindingContext = new OnboardingViewModel();
}
