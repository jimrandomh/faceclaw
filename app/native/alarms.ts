import { Utils } from "@nativescript/core";

declare const com: any;

/**
 * Bridge to the Java alarm clock (FaceclawAlarms / FaceclawAlarmService):
 * the durable phone side of the Timers app's timers and alarms. The phone
 * schedules an exact alarm-clock alarm per item, re-arms them after reboots
 * and time changes, and when one comes due shows it on the phone (silently
 * at first) and adds phone sound if the glasses cannot carry it. Ids are the
 * engine's item ids.
 */

export type AlarmKind = "timer" | "alarm";

export type PhoneAlarmAction = { id: number; action: "dismiss" | "snooze"; minutes: number; atMs: number };

export type AlarmReliabilityIssue = { code: string; message: string; fixable: boolean };

function getContext(): android.content.Context | null {
  if (!global.isAndroid) return null;
  return Utils.android.getApplicationContext() ?? null;
}

/** Schedule (or move) the phone alarm that rings `title` / `text` at triggerAtMs. */
export function schedulePhoneAlarm(
  itemId: number,
  triggerAtMs: number,
  title: string,
  text: string,
  kind: AlarmKind,
  snoozeMinutes: number,
): void {
  const context = getContext();
  if (!context) return;
  com.faceclaw.app.FaceclawAlarms.schedule(context, itemId, triggerAtMs, title, text, kind, snoozeMinutes);
}

/** Cancel the pending phone alarm, stop it if ringing, and clear its notification. */
export function cancelPhoneAlarm(itemId: number): void {
  const context = getContext();
  if (!context) return;
  com.faceclaw.app.FaceclawAlarms.cancel(context, itemId);
}

/** The engine's own expiry path: start the phone ringing flow (deduplicated against the alarm's). */
export function ringPhoneAlarm(itemId: number, title: string, text: string, kind: AlarmKind, snoozeMinutes: number): void {
  const context = getContext();
  if (!context) return;
  com.faceclaw.app.FaceclawAlarms.ring(context, itemId, title, text, kind, snoozeMinutes);
}

/** The glasses are showing the item: the phone starts its 30-second acknowledgement clock. */
export function phoneAlarmDeliveredToGlasses(itemId: number): void {
  const context = getContext();
  if (!context) return;
  com.faceclaw.app.FaceclawAlarms.deliveredToGlasses(context, itemId);
}

/** The wearer dealt with the item on the glasses: the phone goes quiet. */
export function acknowledgePhoneAlarm(itemId: number): void {
  const context = getContext();
  if (!context) return;
  com.faceclaw.app.FaceclawAlarms.acknowledge(context, itemId);
}

/** Tell the phone whether the glasses could carry an alarm right now. */
export function setPhoneAlarmGlassesStatus(connected: boolean, worn: boolean, charging: boolean): void {
  if (!global.isAndroid) return;
  com.faceclaw.app.FaceclawAlarms.setGlassesStatus(connected, worn, charging);
}

let retainedListenerProxy: any = null;
const actionListeners = new Set<(action: PhoneAlarmAction) => void>();

/** Live phone-side dismiss / snooze events (journaled ones arrive through drainPhoneAlarmJournal). */
export function onPhoneAlarmAction(listener: (action: PhoneAlarmAction) => void): () => void {
  if (retainedListenerProxy === null && global.isAndroid) {
    retainedListenerProxy = new com.faceclaw.app.FaceclawAlarmListener({
      onPhoneAction: (id: number, action: string, minutes: number) => {
        const event: PhoneAlarmAction = {
          id: Number(id),
          action: String(action) === "snooze" ? "snooze" : "dismiss",
          minutes: Number(minutes),
          atMs: Date.now(),
        };
        for (const registered of Array.from(actionListeners)) {
          try {
            registered(event);
          } catch (error) {
            console.warn(`phone alarm action listener failed: ${error}`);
          }
        }
      },
    });
    com.faceclaw.app.FaceclawAlarms.setListener(retainedListenerProxy);
  }
  actionListeners.add(listener);
  return () => {
    actionListeners.delete(listener);
  };
}

/** Phone-side actions taken while the engine was not listening, oldest first; cleared on read. */
export function drainPhoneAlarmJournal(): PhoneAlarmAction[] {
  const context = getContext();
  if (!context) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(String(com.faceclaw.app.FaceclawAlarms.drainJournal(context)));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry) => entry && typeof entry === "object" && Number.isFinite(Number(entry.id)))
    .map((entry) => ({
      id: Number(entry.id),
      action: entry.action === "snooze" ? "snooze" : "dismiss",
      minutes: Number(entry.minutes) || 0,
      atMs: Number(entry.at) || 0,
    }));
}

/** Conditions under which the phone may fail to ring, most serious first. */
export function checkPhoneAlarmReliability(): AlarmReliabilityIssue[] {
  const context = getContext();
  if (!context) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(String(com.faceclaw.app.FaceclawAlarms.checkReliability(context)));
  } catch (error) {
    console.warn(`alarm reliability check failed: ${error}`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry) => entry && typeof entry === "object" && typeof entry.code === "string")
    .map((entry) => ({ code: entry.code, message: String(entry.message ?? ""), fixable: entry.fixable !== false }));
}

/** Open the system screen where a reliability issue can be fixed. */
export function openPhoneAlarmReliabilityFix(code: string): void {
  const context = getContext();
  if (!context) return;
  com.faceclaw.app.FaceclawAlarms.openReliabilityFix(context, code);
}

/** The phone's ring / miss / action log, one line per entry, newest last. */
export function readPhoneAlarmLog(): string {
  const context = getContext();
  if (!context) return "";
  return String(com.faceclaw.app.FaceclawAlarms.readLog(context));
}
