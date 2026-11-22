
/** Short weekday names, indexed by `Date#getDay()`. */
export const WEEKDAY_ABBREVIATIONS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Short month names, indexed by `Date#getMonth()`. */
export const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Local time of day in either clock format: "09:05" / "14:05", or "9:05 AM" / "2:05 PM". */
export function formatHourMinute(date: Date, twelveHour: boolean): string {
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const hour24 = date.getHours();
  if (twelveHour) {
    const hour12 = ((hour24 + 11) % 12) + 1;
    return `${hour12}:${minutes} ${hour24 < 12 ? "AM" : "PM"}`;
  }
  return `${String(hour24).padStart(2, "0")}:${minutes}`;
}

export function formatTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatAgeShortFromTimestamp(timestampMs: number | null, nowMs: number): string {
  if (!timestampMs) {
    return "--";
  }
  const elapsedMinutes = Math.max(0, Math.round((nowMs - timestampMs) / 60_000));
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return `${elapsedHours}h`;
  }
  return `${Math.round(elapsedHours / 24)}d`;
}

export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return "";
  const ageMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
