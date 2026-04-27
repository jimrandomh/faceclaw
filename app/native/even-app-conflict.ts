import { Utils } from "@nativescript/core";

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
  if (!global.isAndroid) return;
  const context = Utils.android.getApplicationContext();
  if (context) {
    com.faceclaw.app.FaceclawEvenAppDetector.openEvenAppSettings(context);
  }
}

export function openNotificationAccessSettings(): void {
  if (!global.isAndroid) return;
  const context = Utils.android.getApplicationContext();
  if (context) {
    com.faceclaw.app.FaceclawEvenAppDetector.openNotificationAccessSettings(context);
  }
}
