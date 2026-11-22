/**
 * How the Apple Watch app gets installed, worded once for the phone's pages
 * (phone-ui/watch-app-prompt.ts) and the glasses' Settings > Watch row
 * (ui/dashboard/watch-app-install-menu.ts), so the instructions can't drift
 * apart. The system does the installing, from another iPhone app; Faceclaw can
 * only open that app and say what to do there.
 */
import type { WatchAppInstallSource } from "../native/watch-app-install";

/** Each app the watch app installs from: its name inside a sentence, and what to do once it's open. */
export const WATCH_APP_INSTALLERS: Record<WatchAppInstallSource, { name: string; steps: string }> = {
  "watch-app": { name: "the Watch app", steps: "Scroll down to Available Apps and tap Install next to Faceclaw." },
  testflight: { name: "TestFlight", steps: "On Faceclaw's page, the button that installs the Apple Watch app is under Information." },
};
