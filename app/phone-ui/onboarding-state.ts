import { getBooleanSetting, setBooleanSetting } from "../native/settings-store";

const ONBOARDING_COMPLETE_KEY = "onboarding.complete";
const PREVIEW_ONLY_KEY = "onboarding.previewOnly";
const WELCOME_SOUND_PENDING_KEY = "onboarding.welcomeSoundPending";

export function hasCompletedOnboarding(): boolean {
  return getBooleanSetting(ONBOARDING_COMPLETE_KEY, false);
}

export function setOnboardingCompleted(completed: boolean): void {
  const wasCompleted = hasCompletedOnboarding();
  setBooleanSetting(ONBOARDING_COMPLETE_KEY, completed);
  // Arm the one-time welcome sound on the first-ever completion (not on the
  // idempotent re-completions that happen when installing from the main menu).
  if (completed && !wasCompleted) {
    setWelcomeSoundPending(true);
  }
}

/**
 * True when onboarding just completed and the celebratory sound hasn't played
 * yet. Consumed (and cleared) on the first successful glasses connection.
 */
export function isWelcomeSoundPending(): boolean {
  return getBooleanSetting(WELCOME_SOUND_PENDING_KEY, false);
}

export function setWelcomeSoundPending(pending: boolean): void {
  setBooleanSetting(WELCOME_SOUND_PENDING_KEY, pending);
}

/**
 * True when the user chose to skip flashing during onboarding and use only the
 * on-phone display preview instead of pairing with glasses. Persisted so the
 * app can adapt later; the flashing path clears it.
 */
export function isPreviewOnlyMode(): boolean {
  return getBooleanSetting(PREVIEW_ONLY_KEY, false);
}

export function setPreviewOnlyMode(previewOnly: boolean): void {
  setBooleanSetting(PREVIEW_ONLY_KEY, previewOnly);
}
