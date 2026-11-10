import { EventData, NavigatedData, Page } from "@nativescript/core";

import { NeuralBandViewModel } from "./neural-band-view-model";

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  if (!page.bindingContext) page.bindingContext = new NeuralBandViewModel();
}

export function loaded(args: EventData): void {
  const page = args.object as Page;
  (page.bindingContext as NeuralBandViewModel | undefined)?.onPageLoaded();
}

export function unloaded(args: EventData): void {
  const page = args.object as Page;
  (page.bindingContext as NeuralBandViewModel | undefined)?.onPageUnloaded();
}
