/**
 * Launch-on-call forwarding for shell-side wrapper tools (the "installed"
 * tier in notes/voice-assistant-design.md): an app's own tools are
 * window-scoped ("open" tier), but commands like "start a 5 minute timer"
 * must work with no window open. Wrappers call this to launch the app if its
 * tool isn't registered yet, wait for the window's set-tools declaration to
 * land in the registry, and forward the call. Used by the nav.*, roam.*, and
 * timer.* wrappers; callers should set timeoutMs on their own spec high
 * enough to cover the appear-wait plus the forwarded call's budget.
 */
import { type ToolRegistry, type ToolResult } from "./tool-registry";

const TOOL_APPEAR_TIMEOUT_MS = 5_000;
const TOOL_APPEAR_POLL_MS = 150;

/** Launch appId if needed, wait for its unprefixed tool, and forward the call. */
export async function callAppToolWithLaunch(
  registry: ToolRegistry,
  launchApp: (appId: string) => Promise<void>,
  appId: string,
  unprefixedName: string,
  args: unknown,
): Promise<ToolResult> {
  const fullName = `app.${appId}.${unprefixedName}`;
  if (!registry.listTools().some((tool) => tool.name === fullName)) {
    await launchApp(appId);
    const deadline = Date.now() + TOOL_APPEAR_TIMEOUT_MS;
    while (!registry.listTools().some((tool) => tool.name === fullName)) {
      if (Date.now() > deadline) {
        return { ok: false, error: `The ${appId} app did not start in time.` };
      }
      await sleep(TOOL_APPEAR_POLL_MS);
    }
  }
  return registry.callTool(fullName, args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
