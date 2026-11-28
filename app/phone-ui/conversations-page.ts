import type { EventData, NavigatedData, Page, SearchBar } from "@nativescript/core";

import { focusNeuralBandSearchTarget } from "../g2/neural-band-modalities";
import { ConversationsViewModel } from "./conversations-view-model";

type ConversationsContext = { speakerId?: number } | undefined;
const detachSearchFocus = new WeakMap<SearchBar, () => void>();

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

export function handwritingSearchLoaded(args: EventData): void {
  if (!global.isAndroid) return;
  const bar = args.object as SearchBar;
  const view = bar.android as android.view.View;
  if (!view || detachSearchFocus.has(bar)) return;
  const observer = view.getViewTreeObserver();
  let release: (() => void) | undefined;
  const refreshFocus = () => {
    if (view.hasWindowFocus() && view.findFocus() instanceof android.widget.EditText) {
      release ??= focusNeuralBandSearchTarget({
        getText: () => bar.text ?? "",
        // SearchBar writes the native query with submit=false.
        setText: (text) => { bar.text = text; },
      });
    } else {
      release?.();
      release = undefined;
    }
  };
  const focusListener = new android.view.ViewTreeObserver.OnGlobalFocusChangeListener({
    onGlobalFocusChanged: refreshFocus,
  });
  const windowListener = new android.view.ViewTreeObserver.OnWindowFocusChangeListener({
    onWindowFocusChanged: refreshFocus,
  });
  observer.addOnGlobalFocusChangeListener(focusListener);
  observer.addOnWindowFocusChangeListener(windowListener);
  detachSearchFocus.set(bar, () => {
    release?.();
    const currentObserver = observer.isAlive() ? observer : view.getViewTreeObserver();
    if (!currentObserver.isAlive()) return;
    currentObserver.removeOnGlobalFocusChangeListener(focusListener);
    currentObserver.removeOnWindowFocusChangeListener(windowListener);
  });
  refreshFocus();
}

export function handwritingSearchUnloaded(args: EventData): void {
  const bar = args.object as SearchBar;
  detachSearchFocus.get(bar)?.();
  detachSearchFocus.delete(bar);
}
