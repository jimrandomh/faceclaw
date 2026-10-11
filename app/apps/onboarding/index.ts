import { type AppDefinition } from "../app-definition";
import { createOnboardingAppWindow, ONBOARDING_SURFACE_ID, ONBOARDING_WINDOW_ID } from "./onboarding-app";
import { ONBOARDING_APP_ID } from "./onboarding-progress";

/**
 * First-run setup on the glasses: welcome, text size, data-collection
 * preference. The connection controllers open it on their own when it is
 * due (claimGlassesOnboardingAutoLaunch); the launcher entry reruns it.
 */
const onboardingApp: AppDefinition = {
  appId: ONBOARDING_APP_ID,
  title: "Onboarding",
  icon: "sparkles",
  launch: (ctx) => ctx.launchInProcessApp(ONBOARDING_WINDOW_ID, ONBOARDING_SURFACE_ID, createOnboardingAppWindow),
};

export default onboardingApp;
