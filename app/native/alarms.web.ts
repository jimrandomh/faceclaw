/** Timers still ring on the display; there is no phone to ring them on when the page is closed. */
export type AlarmKind = "timer" | "alarm";
export type PhoneAlarmAction = { id: number; action: "dismiss" | "snooze"; minutes: number; atMs: number };
export type AlarmReliabilityIssue = { code: string; message: string; fixable: boolean };

export function schedulePhoneAlarm(..._args: unknown[]): void {}
export function cancelPhoneAlarm(_itemId: number): void {}
export function ringPhoneAlarm(_itemId: number, _title: string, _text: string, _kind: AlarmKind, _snoozeMinutes: number): void {}
export function phoneAlarmDeliveredToGlasses(_itemId: number): void {}
export function acknowledgePhoneAlarm(_itemId: number): void {}
export function setPhoneAlarmGlassesStatus(_connected: boolean, _worn: boolean, _charging: boolean): void {}
export function onPhoneAlarmAction(_listener: (action: PhoneAlarmAction) => void): () => void { return () => {}; }
export function drainPhoneAlarmJournal(): PhoneAlarmAction[] { return []; }
export function checkPhoneAlarmReliability(): AlarmReliabilityIssue[] { return []; }
export function openPhoneAlarmReliabilityFix(_code: string): void {}
export function readPhoneAlarmLog(): string { return ""; }
