/**
 * The app-wide things analytics reports (the reliability counts come from
 * Kotlin, drained in analytics.ts):
 *  - Minimal: which devices are paired, and which were in use each day;
 *  - Full: which kinds of API key are set, how many terminal and T3 Code
 *    connections there are, the UI font, and every fixed-choice setting.
 * Never anything a person typed in: no keys, addresses, names or URLs.
 */
import { loadEnvironments } from "../apps/t3code/t3-environments";
import { loadConnections } from "../apps/terminal/connections";
import { loadDeviceAddresses } from "../g2/device-addresses";
import { onGlassesPresenceChanged } from "../g2/glasses-presence";
import { isPreinstalledFont } from "../graphics/installed-fonts";
import { getUiFontSelection } from "../graphics/ui-fonts";
import { getStringSetting } from "../native/settings-store";
import { isPreviewOnlyMode } from "../phone-ui/onboarding-state";
import { fixedChoiceSettingValues, ringConnectionModeSetting } from "../ui/dashboard-settings";
import { addInputListener } from "../ui/input-monitor";
import { flagAnalyticsEvent, registerAnalyticsSnapshot, startAnalytics } from "./analytics";
import type { Snapshot } from "./analytics-store";

/** Settings holding API keys and tokens, reported only as set or not, by kind. */
const API_KEY_SETTINGS: Record<string, string> = {
  anthropic: "llm.anthropicApiKey",
  openai: "voice.openAiApiKey",
  elevenlabs: "voice.elevenLabsApiKey",
  soniox: "voice.sonioxApiKey",
  mapbox: "maps.mapboxApiKey",
  roam: "integrations.roam.apiToken",
  nightscout: "integrations.nightscout.apiToken",
  "agent-bridge": "assistant.bridgeToken",
  evenhub: "integrations.evenhub.token",
};

let started = false;

/** Registers the sources above and starts analytics. Main thread, at boot. */
export function startAppAnalytics(): void {
  if (started) return;
  started = true;
  registerAnalyticsSnapshot("minimal", deviceSnapshot);
  registerAnalyticsSnapshot("full", configurationSnapshot);

  onGlassesPresenceChanged((presence) => {
    if (presence.connected) flagAnalyticsEvent("minimal", "device.g2.used");
  });
  addInputListener((event) => {
    if (!("source" in event)) return;
    if (event.source === "ring") flagAnalyticsEvent("minimal", "device.r1.used");
    else if (event.source === "left-arm" || event.source === "right-arm") flagAnalyticsEvent("minimal", "device.g2.touchpad-used");
  });
  startAnalytics();
}

function deviceSnapshot(): Snapshot {
  const addresses = loadDeviceAddresses();
  return {
    "device.g2.paired": Boolean(addresses.left && addresses.right),
    "device.g2.preview-only": isPreviewOnlyMode(),
    "device.r1.paired": Boolean(addresses.ring),
    "device.r1.connection": ringConnectionModeSetting.get(),
  };
}

function configurationSnapshot(): Snapshot {
  const snapshot: Snapshot = {};
  for (const [kind, storageKey] of Object.entries(API_KEY_SETTINGS)) {
    snapshot[`apikey.${kind}`] = getStringSetting(storageKey, "").trim() !== "";
  }
  snapshot["config.nightscout-site"] = getStringSetting("integrations.nightscout.siteUrl", "").trim() !== "";
  snapshot["config.terminal-connections"] = loadConnections().length;
  snapshot["config.t3code-environments"] = loadEnvironments().length;

  const font = getUiFontSelection();
  snapshot["config.ui-font"] =
    font.kind === "bitmap"
      ? font.face
      : `${isPreinstalledFont(font.file) ? font.file.replace(/\.ttf$/i, "") : "installed"}:${font.size}`;

  for (const [storageKey, value] of Object.entries(fixedChoiceSettingValues())) {
    snapshot[`setting.${storageKey}`] = value;
  }
  return snapshot;
}
