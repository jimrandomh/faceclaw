import { ApplicationSettings } from "@nativescript/core";

const ONBOARDING_COMPLETE_KEY = "onboarding.complete";
const PREVIEW_ONLY_KEY = "onboarding.previewOnly";

export function hasCompletedOnboarding(): boolean {
  return ApplicationSettings.getBoolean(ONBOARDING_COMPLETE_KEY, false);
}

/**
 * Phone-side onboarding. The on-glasses onboarding that follows it on the
 * first connection is tracked separately (app/apps/onboarding/).
 */
export function setOnboardingCompleted(completed: boolean): void {
  ApplicationSettings.setBoolean(ONBOARDING_COMPLETE_KEY, completed);
}

/**
 * True when the user chose to skip flashing during onboarding and use only the
 * on-phone display preview instead of pairing with glasses. Persisted so the
 * app can adapt later; the flashing path clears it.
 */
export function isPreviewOnlyMode(): boolean {
  return ApplicationSettings.getBoolean(PREVIEW_ONLY_KEY, false);
}

export function setPreviewOnlyMode(previewOnly: boolean): void {
  ApplicationSettings.setBoolean(PREVIEW_ONLY_KEY, previewOnly);
}
