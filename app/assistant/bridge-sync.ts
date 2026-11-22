import {
  assistantAllowProactiveSetting,
  assistantBackendSetting,
  assistantBridgeHostSetting,
  assistantBridgePortSetting,
  assistantBridgeTokenSetting,
} from "../ui/dashboard-settings";
import { assistantBridge } from "./bridge-client";

/**
 * Keeps the agent-bridge connection (assistantBridge) following the Assistant
 * settings, for both platforms' controllers: up, re-dialing as needed, while
 * "My own agent" is the backend and its host and token are set, so the agent
 * can make proactive tool calls outside voice turns.
 */

// The settings the connection was last started (or dropped) for. Changing one
// re-dials; unrelated setting changes must not.
let appliedConfig: string | null = null;

function bridgeConfig(): string {
  return JSON.stringify([
    assistantBackendSetting.get(),
    assistantBridgeHostSetting.get().trim(),
    assistantBridgePortSetting.get().trim(),
    assistantBridgeTokenSetting.get(),
  ]);
}

/**
 * Bring the connection in line with the settings. Does nothing while they are
 * the ones already applied, so it is safe to call on every settings change.
 */
export function syncAssistantBridge(): void {
  const config = bridgeConfig();
  if (config === appliedConfig) return;
  appliedConfig = config;
  const host = assistantBridgeHostSetting.get().trim();
  const token = assistantBridgeTokenSetting.get();
  if (assistantBackendSetting.get() !== "external" || !host || !token) {
    assistantBridge.stop();
    return;
  }
  assistantBridge.configure({
    host,
    port: parseInt(assistantBridgePortSetting.get(), 10) || 8790,
    token,
    deviceName: "faceclaw",
    allowProactive: () => assistantAllowProactiveSetting.get(),
  });
}

/** Drop the connection until the next syncAssistantBridge(). */
export function stopAssistantBridge(): void {
  appliedConfig = null;
  assistantBridge.stop();
}
