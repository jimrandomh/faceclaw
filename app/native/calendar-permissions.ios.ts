import { Dialogs, Utils } from "@nativescript/core";

declare const FaceclawCalendar: any;

export function hasCalendarPermission(): boolean {
  return FaceclawCalendar.shared().hasPermission();
}

let pending: Promise<boolean> | null = null;

export function ensureCalendarPermission(): Promise<boolean> {
  if (hasCalendarPermission()) return Promise.resolve(true);
  if (!pending) pending = requestPermission().finally(() => { pending = null; });
  return pending;
}

async function requestPermission(): Promise<boolean> {
  const calendar = FaceclawCalendar.shared();
  const status = String(calendar.permissionStatus());
  if (status === "denied") {
    const open = await Dialogs.confirm({
      title: "Calendar Access",
      message: "Allow calendar access in Settings to display your events on the glasses. On iOS 17 or later, choose Full Access.",
      okButtonText: "Open Settings",
      cancelButtonText: "Cancel",
    });
    if (open) await Utils.openUrl("app-settings:");
    return false;
  }
  if (status === "restricted") {
    await Dialogs.alert({
      title: "Calendar Access Restricted",
      message: "Calendar access is restricted on this iPhone. Check Screen Time or device management settings.",
      okButtonText: "OK",
    });
    return false;
  }
  return new Promise<boolean>((resolve, reject) => {
    calendar.requestPermission((granted: boolean, error: string | null) => {
      if (error) reject(new Error(String(error)));
      else resolve(granted);
    });
  });
}
