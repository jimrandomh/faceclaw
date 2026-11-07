import { ApplicationSettings } from "@nativescript/core";

import { getBooleanSetting, setBooleanSetting } from "../native/settings-store";

const ONBOARDING_COMPLETE_KEY = "onboarding.complete";
const PREVIEW_ONLY_KEY = "onboarding.previewOnly";
// The "onboarding." prefix keeps these on this phone in config transfers and
// lets scripts/resetOnboarding.sh clear them.
const OWNS_RING_KEY = "onboarding.ownsRing";
const OWNS_WATCH_KEY = "onboarding.ownsWatch";

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

/**
 * Accessories chosen on the Your Devices onboarding page, for tailoring the
 * rest of setup. The glasses chosen there go in glassesTypeSetting instead.
 */
export function ownsRing(): boolean {
  return getBooleanSetting(OWNS_RING_KEY, false);
}

export function setOwnsRing(owns: boolean): void {
  setBooleanSetting(OWNS_RING_KEY, owns);
}

/** An Apple Watch on iOS, a Wear OS watch on Android. */
export function ownsWatch(): boolean {
  return getBooleanSetting(OWNS_WATCH_KEY, false);
}

export function setOwnsWatch(owns: boolean): void {
  setBooleanSetting(OWNS_WATCH_KEY, owns);
}
