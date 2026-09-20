import { NavigatedData, Page } from "@nativescript/core";

import { SpeakersViewModel } from "./speakers-view-model";

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  let model = page.bindingContext as SpeakersViewModel | undefined;
  if (!model) {
    model = new SpeakersViewModel();
    page.bindingContext = model;
  }
  // Reload every time so edits made from a conversation page (re-diarize,
  // split, reassign) show up on the way back.
  model.reload();
}
