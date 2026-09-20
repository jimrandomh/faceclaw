import { NavigatedData, Page } from "@nativescript/core";

import { AskViewModel } from "./ask-view-model";

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new AskViewModel();
  }
}

export function unloaded(args: NavigatedData): void {
  const page = args.object as Page;
  (page.bindingContext as AskViewModel | undefined)?.cancel();
}
