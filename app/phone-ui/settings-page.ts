import { EventData, NavigatedData, Page } from "@nativescript/core";

import { SettingsViewModel } from "./settings-view-model";

/**
 * The phone's settings page, opened by the gear button under the main page's
 * mirror. Shared by Android and iOS (registered in onboarding-register.ios.ts).
 */
export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  if (!page.bindingContext) page.bindingContext = new SettingsViewModel();
}

// loaded/unloaded also bracket an app suspend, so the model's subscriptions
// only live while the page is actually on screen.
export function loaded(args: EventData): void {
  ((args.object as Page).bindingContext as SettingsViewModel | undefined)?.attach();
}

export function unloaded(args: EventData): void {
  ((args.object as Page).bindingContext as SettingsViewModel | undefined)?.detach();
}
