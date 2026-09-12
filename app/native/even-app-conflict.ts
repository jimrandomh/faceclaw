import { Dialogs, Utils } from "@nativescript/core";

declare const com: any;

export type EvenAppNotificationState = {
  notificationAccessEnabled: boolean;
  evenNotificationActive: boolean;
};

export function readEvenAppNotificationState(): EvenAppNotificationState {
  if (!global.isAndroid) {
    return { notificationAccessEnabled: false, evenNotificationActive: false };
  }
  const context = Utils.android.getApplicationContext();
  if (!context) {
    return { notificationAccessEnabled: false, evenNotificationActive: false };
  }
  const detector = com.faceclaw.app.FaceclawEvenAppDetector;
  return {
    notificationAccessEnabled: Boolean(detector.isNotificationAccessEnabled(context)),
    evenNotificationActive: Boolean(detector.isEvenNotificationActive(context)),
  };
}

export function openEvenAppSettings(): void {
  const context = global.isAndroid ? Utils.android.getApplicationContext() : null;
  const result = context
    ? com.faceclaw.app.FaceclawEvenAppDetector.openEvenAppSettings(context)
    : "failed";
  if (result === "opened") return;
  const notInstalled = result === "not-installed";
  void Dialogs.alert({
    title: notInstalled ? "Even app not installed" : "Unable to open Even app settings",
    message: notInstalled
      ? "The official Even Realities app isn't installed on this phone. If your glasses are connected to another app or phone, disconnect them there. Otherwise, you can continue."
      : "Open your phone's settings manually to manage the Even app, or disconnect your glasses from within the app that's connected to them.",
    okButtonText: "OK",
  });
}

export function openNotificationAccessSettings(): void {
  if (!global.isAndroid) return;
  const context = Utils.android.getApplicationContext();
  if (context) {
    com.faceclaw.app.FaceclawEvenAppDetector.openNotificationAccessSettings(context);
  }
}
