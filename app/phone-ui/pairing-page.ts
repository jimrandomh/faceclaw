import { NavigatedData, Page } from "@nativescript/core";

import { PairingViewModel } from "./pairing-view-model";

type PairingContext = { onboarding?: boolean } | undefined;

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  // Preserve the model across back-navigation (returning from the firmware
  // check or manual-entry pages) so the selection isn't lost; the model
  // restarts its scan on re-entry.
  let model = page.bindingContext as PairingViewModel | undefined;
  if (!model) {
    const context = args.context as PairingContext;
    model = new PairingViewModel({ onboarding: context?.onboarding ?? false });
    page.bindingContext = model;
  }
  void model.start();
}

export function navigatingFrom(args: NavigatedData): void {
  const page = args.object as Page;
  const model = page.bindingContext as PairingViewModel | undefined;
  // Backing out destroys the page; a forward navigation (manual entry) keeps
  // it on the stack, so only pause the scan and keep the model's app-lifecycle
  // hooks for the return trip.
  if (args.isBackNavigation) {
    model?.dispose();
  } else {
    model?.stop();
  }
}
