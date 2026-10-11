import { GrayImage } from "../../graphics/image";
import type { InputEvent } from "../../ui/gestures";
import type { Layer, LayerActions, LayerContext } from "../../ui/layers";
import { createInProcessWindow, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { findSoundEffect, playSoundEffect } from "../../ui/sound-effects";
import { DataCollectionPage } from "./data-collection-page";
import { IosPrivacyPage } from "./ios-privacy-page";
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
    new DataCollectionPage(),
  ];
  const app = createInProcessWindow({
    appId: ONBOARDING_APP_ID,
    windowId: ONBOARDING_WINDOW_ID,
    title: "Onboarding",
    iconLetter: "On",
    icon: "sparkles",
    closeable: true,
    actions: options.actions,
    baseLayer: new OnboardingLayer(pages, () => {
      markGlassesOnboardingFinished();
      shell.closeWindow(ONBOARDING_WINDOW_ID);
    }),
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
 * Hosts the current page. Double-click steps back a page, or leaves the app
 * from the first one (the standard yield to the app switcher); every other
 * gesture goes to the page.
 */
class OnboardingLayer implements Layer {
  private index = 0;

  constructor(
    private readonly pages: readonly OnboardingPage[],
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
      if (this.index === 0) shell.yieldFocusToSidebar();
      else this.show(this.index - 1);
      return;
    }
    await this.pages[this.index]!.handleInput(event, { next: () => this.next() });
  }

  private next(): void {
    if (this.index + 1 < this.pages.length) this.show(this.index + 1);
    else this.finish();
  }

  private show(index: number): void {
    this.index = index;
    this.pages[index]!.enter?.();
  }
}
