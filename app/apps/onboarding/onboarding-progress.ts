/**
 * Whether the on-glasses onboarding is due: it is recorded as finished per
 * Faceclaw version, so it runs on the first connection after phone-side
 * setup and again after any upgrade. The key shares the phone onboarding's
 * "onboarding." prefix so scripts/resetOnboarding.sh clears it too.
 */
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { FACECLAW_VERSION } from "../../version";

export const ONBOARDING_APP_ID = "onboarding";

const FINISHED_VERSION_KEY = "onboarding.glassesFinishedVersion";

export function isGlassesOnboardingDue(): boolean {
  return getStringSetting(FINISHED_VERSION_KEY, "") !== FACECLAW_VERSION;
}

export function markGlassesOnboardingFinished(): void {
  setStringSetting(FINISHED_VERSION_KEY, FACECLAW_VERSION);
}

let autoLaunchChecked = false;

/**
 * Asked by the connection controllers on each rendered frame (the session
 * is warm by then, so the onboarding's welcome jingle won't be dropped).
 * True at most once per run, and only when onboarding is due: closing it
 * unfinished brings it back on the next app start, not on every reconnect.
 */
export function claimGlassesOnboardingAutoLaunch(): boolean {
  if (autoLaunchChecked) return false;
  autoLaunchChecked = true;
  return isGlassesOnboardingDue();
}
