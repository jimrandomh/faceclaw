import { EventData, Page } from "@nativescript/core";

import { OnboardingDevicesViewModel } from "./onboarding-devices-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new OnboardingDevicesViewModel();
  }
}

// loaded/unloaded also bracket an app suspend, so the model follows the watch
// app's install state only while the page is on screen.
export function loaded(args: EventData): void {
  ((args.object as Page).bindingContext as OnboardingDevicesViewModel | undefined)?.attach();
}

export function unloaded(args: EventData): void {
  ((args.object as Page).bindingContext as OnboardingDevicesViewModel | undefined)?.detach();
}
