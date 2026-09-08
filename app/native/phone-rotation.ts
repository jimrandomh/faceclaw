import { Application, isAndroid } from "@nativescript/core";
import { getStringSetting, onSettingsStoreChanged } from "./settings-store";

// Shared with phoneRotationSetting; keep startup independent of the glasses UI.
const ROTATION_KEY = "phone.rotation";

/** Installed once on the UI thread; also covers navigation and activity recreation. */
export function registerPhoneRotation(): void {
  if (!isAndroid) return;

  const apply = (activity = Application.android.foregroundActivity ?? Application.android.startActivity): void => {
    if (!activity) return;
    const orientations = android.content.pm.ActivityInfo;
    const requested = {
      auto: orientations.SCREEN_ORIENTATION_UNSPECIFIED,
      portrait: orientations.SCREEN_ORIENTATION_PORTRAIT,
      landscape: orientations.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,
    }[getStringSetting(ROTATION_KEY, "auto")] ?? orientations.SCREEN_ORIENTATION_UNSPECIFIED;
    if (activity.getRequestedOrientation() !== requested) {
      activity.setRequestedOrientation(requested);
    }
  };

  Application.android.on(Application.android.activityCreatedEvent, (args) => apply(args.activity));
  Application.android.on(Application.android.activityResumedEvent, (args) => apply(args.activity));
  onSettingsStoreChanged((key) => {
    if (key === ROTATION_KEY) apply();
  });
  apply();
}
