import { Dialogs } from "@nativescript/core";

import { WATCH_APP_INSTALLERS } from "../g2/watch-app-install-guide";
import { watchAppInstall } from "../native/watch-app-install";

/**
 * What a phone page shows about the Apple Watch app: nothing, that the watch
 * has it, or the way to install it. Shared by the settings page and the Your
 * Devices onboarding page, so the two word it alike.
 */
export type WatchAppPrompt = {
  /** False with no paired watch to say anything about (always, on Android). */
  visible: boolean;
  installed: boolean;
  /** The watch lacks the app and this copy of Faceclaw has somewhere to install it from. */
  canInstall: boolean;
  /** Where the Install button leads, or why there isn't one; "" for nothing to add. */
  hint: string;
};

/** Only a build from source can lack the watch app, so this is for whoever built it. */
const NOT_BUNDLED_HINT = "This build of Faceclaw was made without its watch app. See apple-watch/README.md.";

export function watchAppPrompt(): WatchAppPrompt {
  const state = watchAppInstall.getState();
  if (state === "installed") return { visible: true, installed: true, canInstall: false, hint: "" };
  if (state !== "not-installed") return { visible: false, installed: false, canInstall: false, hint: "" };
  const source = watchAppInstall.getSource();
  if (!source) return { visible: true, installed: false, canInstall: false, hint: NOT_BUNDLED_HINT };
  const { name, steps } = WATCH_APP_INSTALLERS[source];
  return { visible: true, installed: false, canInstall: true, hint: `Opens ${name}. ${steps}` };
}

/** The Install button: hand over to the app that installs the watch app. */
export async function openWatchAppInstall(): Promise<void> {
  const source = watchAppInstall.getSource();
  if (!source || (await watchAppInstall.openSource())) return;
  const { name, steps } = WATCH_APP_INSTALLERS[source];
  await Dialogs.alert({ title: "Apple Watch", message: `Couldn't open ${name}. Open it from the Home Screen. ${steps}`, okButtonText: "OK" });
}
