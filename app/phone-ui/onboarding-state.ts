import { ApplicationSettings } from "@nativescript/core";

const ONBOARDING_COMPLETE_KEY = "onboarding.complete";

export function hasCompletedOnboarding(): boolean {
  return ApplicationSettings.getBoolean(ONBOARDING_COMPLETE_KEY, false);
}

export function setOnboardingCompleted(completed: boolean): void {
  ApplicationSettings.setBoolean(ONBOARDING_COMPLETE_KEY, completed);
}
