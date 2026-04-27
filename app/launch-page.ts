import { EventData, Frame, Page } from "@nativescript/core";

import { hasCompletedOnboarding } from "./onboarding-state";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  page.on(Page.loadedEvent, () => {
    Frame.topmost()?.navigate({
      moduleName: hasCompletedOnboarding() ? "main-page" : "onboarding-page",
      clearHistory: true,
      animated: false,
    });
  });
}
