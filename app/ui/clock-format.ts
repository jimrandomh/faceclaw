/**
 * Clock/date text shared by the shell's top bar and the Glanceboard's System
 * Card, so the two never disagree on the time-format setting or the date
 * spelling.
 */
import { timeFormatSetting } from "./dashboard-settings";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format a clock time, honoring the 12/24-hour setting ("14:05" / "2:05 PM"). */
export function formatClockTime(now: Date): string {
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const hour24 = now.getHours();
  if (timeFormatSetting.get() === "12h") {
    const hour12 = ((hour24 + 11) % 12) + 1;
    return `${hour12}:${minutes} ${hour24 < 12 ? "AM" : "PM"}`;
  }
  return `${hour24}:${minutes}`;
}

/** Short date as the top bar shows it: "Thu 11 Sep". */
export function formatClockDate(now: Date): string {
  return `${WEEKDAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]}`;
}
