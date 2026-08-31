import { EventData, NavigatedData, Page } from "@nativescript/core";

import { ConversationViewModel } from "./conversation-view-model";

type ConversationContext = { sessionId?: number } | undefined;

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  let model = page.bindingContext as ConversationViewModel | undefined;
  if (!model) {
    const context = args.context as ConversationContext;
    model = new ConversationViewModel(context?.sessionId ?? 0);
    page.bindingContext = model;
  }
  model.reload();
}

export function unloaded(args: EventData): void {
  const page = args.object as Page;
  const model = page.bindingContext as ConversationViewModel | undefined;
  // The page has no forward navigation, so unloaded means it's going away:
  // stop playback and release the MediaPlayer.
  model?.dispose();
}
