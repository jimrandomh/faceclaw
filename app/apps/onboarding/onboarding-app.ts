import { GrayImage } from "../../graphics/image";
import type { InputEvent } from "../../ui/gestures";
import type { Layer, LayerActions, LayerContext } from "../../ui/layers";
import { createInProcessWindow, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { findSoundEffect, playSoundEffect } from "../../ui/sound-effects";
import { DataCollectionPage } from "./data-collection-page";
import { DepthPage } from "./depth-page";
import { DisplayModePage } from "./display-mode-page";
import { IosPrivacyPage } from "./ios-privacy-page";
import { LayoutPage } from "./layout-page";
import { markGlassesOnboardingFinished, ONBOARDING_APP_ID } from "./onboarding-progress";
import type { OnboardingPage } from "./onboarding-page";
import { TextSizePage } from "./text-size-page";
import { WelcomePage } from "./welcome-page";

export const ONBOARDING_WINDOW_ID = "onboarding";
export const ONBOARDING_SURFACE_ID = "window:onboarding";

/**
 * The on-glasses onboarding: a fixed sequence of pages, opened automatically
 * on the first connection after phone-side setup and after each upgrade
 * (see onboarding-progress.ts), and from the launcher any time. Finishing
 * the last page records this version as onboarded and closes the window;
 * closing it early leaves onboarding due.
 */
export function createOnboardingAppWindow(options: InProcessAppOptions): InProcessWindow {
  const pages: OnboardingPage[] = [
    new WelcomePage(), new TextSizePage(),
    ...(global.isIOS ? [new IosPrivacyPage()] : []),
    new DataCollectionPage(), new LayoutPage(), new DepthPage(), new DisplayModePage(),
  ];
  const app = createInProcessWindow({
    appId: ONBOARDING_APP_ID,
    windowId: ONBOARDING_WINDOW_ID,
    title: "Onboarding",
    iconLetter: "On",
    icon: "sparkles",
    closeable: true,
    immersive: pages[0]!.immersive,
    actions: options.actions,
    baseLayer: new OnboardingLayer(
      pages,
      // Only called on page changes, by when `app` is set.
      (immersive) => app.setImmersive(immersive),
      () => {
        markGlassesOnboardingFinished();
        shell.closeWindow(ONBOARDING_WINDOW_ID);
      },
    ),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    reconfigureSurface: options.reconfigureSurface,
    onClosed: options.onClosed,
  });
  playWelcomeSound(options.actions);
  return app;
}

/** The celebratory jingle that greets the welcome page (formerly played on the first connection). */
function playWelcomeSound(actions: LayerActions): void {
  const effect = findSoundEffect("questcomplete");
  if (!effect) return;
  playSoundEffect(
    effect,
    (payload) => actions.playBuzzerSequence(payload),
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ).catch((error) => console.warn(`onboarding welcome sound failed: ${error}`));
}

/**
 * Hosts the current page, immersive or not as it asks. Double-click steps
 * back a page, or leaves the app from the first one (the standard yield to
 * the app switcher); every other gesture goes to the page. Pages that don't
 * apply (Depth beside a side-strip app switcher) are skipped either way.
 */
export class OnboardingLayer implements Layer {
  private index = 0;

  constructor(
    private readonly pages: readonly OnboardingPage[],
    private readonly setImmersive: (immersive: boolean) => void,
    private readonly finish: () => void,
  ) {
    pages[0]!.enter?.();
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    this.pages[this.index]!.paint(image, ctx.stack.isFocused());
    return image;
  }

  async handleInput(event: InputEvent): Promise<void> {
    if (event.type === "double-click") {
      const previous = this.applicableIndex(this.index - 1, -1);
      if (previous === null) shell.yieldFocusToSidebar();
      else this.show(previous);
      return;
    }
    await this.pages[this.index]!.handleInput(event, { next: () => this.next() });
  }

  private next(): void {
    const next = this.applicableIndex(this.index + 1, 1);
    if (next === null) this.finish();
    else this.show(next);
  }

  /** The first page from `index` on in direction `step` that applies, if any. */
  private applicableIndex(index: number, step: 1 | -1): number | null {
    for (; index >= 0 && index < this.pages.length; index += step) {
      if (this.pages[index]!.applies?.() ?? true) return index;
    }
    return null;
  }

  private show(index: number): void {
    this.index = index;
    const page = this.pages[index]!;
    page.enter?.();
    this.setImmersive(page.immersive ?? false);
  }
}
