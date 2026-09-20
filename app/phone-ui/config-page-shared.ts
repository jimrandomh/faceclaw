import { NavigatedData, Page } from "@nativescript/core";

import { ConfigViewModel } from "./config-view-model";

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  // Preserve the model across back-navigation (returning from the firmware
  // check page) so the onboarding "Continue" flow isn't lost.
  if (!page.bindingContext) {
    const context = (args.context as { onboarding?: boolean } | undefined) ?? undefined;
    page.bindingContext = new ConfigViewModel({ onboarding: context?.onboarding ?? false });
  }
}
