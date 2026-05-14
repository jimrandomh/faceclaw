import { EventData, Frame, Page } from "@nativescript/core";

import { hasCompletedOnboarding } from "./onboarding-state";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  page.on(Page.loadedEvent, () => {
    Frame.topmost()?.navigate({
      moduleName: hasCompletedOnboarding() ? "phone-ui/main-page" : "phone-ui/onboarding-page",
      clearHistory: true,
      animated: false,
    });
  });
}
