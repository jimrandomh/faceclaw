import { type AppContext } from "../app-definition";
import { nightscoutBridge, type NightscoutState } from "../../native/nightscout-bridge";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { nightscoutMissedBolusAlertsSetting, nightscoutMissedBolusCooldownSetting } from "../../ui/dashboard-settings";
import { shell } from "../../ui/shell/shell";
import { detectMissedBolus, type MissedBolusInput } from "./missed-bolus-detector";
import { MissedBolusNotificationLayer } from "./missed-bolus-notification";

/** When the last alert was shown, persisted so a restart doesn't reset the cooldown. */
const LAST_ALERT_STORAGE_KEY = "integrations.nightscout.missedBolusLastAlertMs";

let started = false;
let lastInputKey = "";
let lastSummary = "";

/**
 * Runs the missed-bolus detector each time a Nightscout sync brings new
 * readings or treatments, and shows a glasses notification when it fires
 * outside the cooldown. Shell-lifetime, started from the app's boot hook.
 */
export function startMissedBolusMonitor(ctx: AppContext): void {
  if (started) return;
  started = true;
  nightscoutBridge.onStateChange((state) => checkForMissedBolus(state, ctx));
}

function checkForMissedBolus(state: NightscoutState, ctx: AppContext): void {
  if (!nightscoutMissedBolusAlertsSetting.get() || !state.available) return;
  const key = inputKey(state);
  if (key === lastInputKey) return;
  lastInputKey = key;

  const nowMs = Date.now();
  const result = detectMissedBolus(detectorInput(state, nowMs));
  const summary = `${result.classification}: ${result.reason}`;
  if (summary !== lastSummary) {
    lastSummary = summary;
    console.log(`missed-bolus detector: ${summary}`);
  }
  if (result.classification !== "missed-bolus" || !result.rise) return;

  const lastAlertMs = Number(getStringSetting(LAST_ALERT_STORAGE_KEY, "0")) || 0;
  const cooldownMs = Number(nightscoutMissedBolusCooldownSetting.get()) * 60_000;
  // A last-alert time in the future means the clock moved back; don't let it block alerts.
  if (lastAlertMs <= nowMs && nowMs - lastAlertMs < cooldownMs) return;
  setStringSetting(LAST_ALERT_STORAGE_KEY, String(nowMs));
  ctx.appendLog(`missed-bolus alert: ${result.reason}`);
  const rise = result.rise;
  shell.postAppNotification({
    key: `nightscout-missed-bolus:${nowMs}`,
    createLayer: (close) => new MissedBolusNotificationLayer(rise, nowMs, close, () => {
      void ctx.launchApp("nightscout");
    }),
  });
}

/** Changes whenever a sync brings a new reading or a treatment the detector reads. */
function inputKey(state: NightscoutState): string {
  return [
    state.latest?.timestampMs ?? 0,
    state.boluses.map((bolus) => bolus.timestampMs).join(","),
    state.carbs.map((entry) => entry.timestampMs).join(","),
  ].join("|");
}

function detectorInput(state: NightscoutState, nowMs: number): MissedBolusInput {
  return {
    nowMs,
    glucose: state.history.map((point) => ({ timeMs: point.timestampMs, mgdl: point.sgv })),
    boluses: state.boluses.map((bolus) => ({ timeMs: bolus.timestampMs, units: bolus.insulin, kind: bolus.kind })),
    carbs: state.carbs.map((entry) => ({ timeMs: entry.timestampMs, grams: entry.carbs })),
  };
}
