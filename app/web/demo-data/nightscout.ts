/**
 * A pretend Nightscout server for the Nightscout demo: answers the real bridge's
 * requests (nightscout-bridge.ts) through fetchTextWithUserAgent, so the app, its
 * graph and the status-bar reading all run for real on made-up numbers.
 */
export const DEMO_NIGHTSCOUT_URL = "https://sample-nightscout.invalid";
export const DEMO_NIGHTSCOUT_TOKEN = "sample";

const FIVE_MINUTES = 5 * 60_000;

/** A gentle, plausible trace that stays in range: a meal's rise and fall on a slow drift. */
function glucoseAt(ms: number): number {
  const hours = ms / 3_600_000;
  return Math.round(118 + 26 * Math.sin(hours * 1.3) + 11 * Math.sin(hours * 3.1 + 1) + 4 * Math.sin(hours * 7.7));
}

function directionAt(ms: number): string {
  const delta = glucoseAt(ms) - glucoseAt(ms - FIVE_MINUTES);
  if (delta > 9) return "SingleUp";
  if (delta > 4) return "FortyFiveUp";
  if (delta < -9) return "SingleDown";
  if (delta < -4) return "FortyFiveDown";
  return "Flat";
}

function entries(now: number): unknown[] {
  const latest = Math.floor(now / FIVE_MINUTES) * FIVE_MINUTES;
  const rows: unknown[] = [];
  for (let i = 0; i < 40; i++) {
    const date = latest - i * FIVE_MINUTES;
    rows.push({ date, sgv: glucoseAt(date), direction: directionAt(date) });
  }
  return rows;
}

function treatments(now: number): unknown[] {
  const iso = (agoMinutes: number) => new Date(now - agoMinutes * 60_000).toISOString();
  return [
    { created_at: iso(38), eventType: "Meal Bolus", carbs: 32, insulin: 3.2, wizard: true },
    { created_at: iso(125), eventType: "Correction Bolus", insulin: 0.6 },
    { created_at: iso(150), eventType: "Temp Basal", rate: 0.9, absolute: 0.9, duration: 30 },
  ];
}

function deviceStatus(now: number): unknown[] {
  const timestamp = new Date(now - 90_000).toISOString();
  return [{
    created_at: timestamp,
    openaps: { iob: { iob: 1.42, timestamp }, suggested: { COB: 14, timestamp } },
    pump: { clock: timestamp, reservoir: 112.5, battery: { voltage: 1.38 }, status: { status: "normal", bolusing: false, suspended: false, timestamp } },
  }];
}

/** The JSON a real server would give this URL, or null if it isn't for the sample server. */
export function demoNightscoutResponse(url: string): unknown {
  if (!url.startsWith(DEMO_NIGHTSCOUT_URL)) return null;
  const now = Date.now();
  if (url.includes("/api/v1/entries.json")) return entries(now);
  if (url.includes("/api/v1/devicestatus.json")) return deviceStatus(now);
  if (url.includes("/api/v1/status.json")) return { settings: { units: "mg/dL" } };
  if (url.includes("Site%20Change")) return [{ created_at: new Date(now - 2.2 * 86_400_000).toISOString(), eventType: "Site Change" }];
  if (url.includes("/api/v1/treatments.json")) return treatments(now);
  return [];
}
