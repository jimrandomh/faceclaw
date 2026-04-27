import { EventData, Page } from "@nativescript/core";

import { ConfigViewModel } from "./config-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  page.bindingContext = new ConfigViewModel();
}
