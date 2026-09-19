import { EventData, NavigatedData, Page } from "@nativescript/core";

import { PermissionsViewModel } from "./permissions-view-model";

type PermissionsContext = { onboarding?: boolean } | undefined;

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  // Preserve the model when returning via back navigation (from the step-3
  // onboarding page); statuses are re-checked in the loaded handler.
  if (!page.bindingContext) {
    const context = args.context as PermissionsContext;
    page.bindingContext = new PermissionsViewModel({ onboarding: context?.onboarding ?? false });
  }
}

export function loaded(args: EventData): void {
  const page = args.object as Page;
  (page.bindingContext as PermissionsViewModel | undefined)?.onPageLoaded();
}

export function unloaded(args: EventData): void {
  const page = args.object as Page;
  (page.bindingContext as PermissionsViewModel | undefined)?.onPageUnloaded();
}
