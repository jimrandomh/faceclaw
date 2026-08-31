import { NavigatedData, Page } from "@nativescript/core";

import { ConversationsViewModel } from "./conversations-view-model";

type ConversationsContext = { speakerId?: number } | undefined;

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  // Preserve the model across back-navigation (returning from a conversation
  // or the speakers page) so the search and filters aren't lost; reload every
  // time so deletions, merges, and renames made elsewhere show up.
  let model = page.bindingContext as ConversationsViewModel | undefined;
  if (!model) {
    const context = args.context as ConversationsContext;
    model = new ConversationsViewModel({ speakerId: context?.speakerId });
    page.bindingContext = model;
  }
  model.reload();
}
