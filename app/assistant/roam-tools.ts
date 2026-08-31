/**
 * Shell-side roam.* assistant tools. The Roam app's own tools are
 * window-scoped ("open" tier), but "add milk to my todo list" should work
 * with the app closed — so these always-available wrappers launch the app,
 * wait for its tools to register, and forward the call.
 */
import { roamApiTokenSetting, roamGraphNameSetting } from "../ui/dashboard-settings";
import { toolRegistry, type ToolRegistry, type ToolResult } from "./tool-registry";
import { callAppToolWithLaunch } from "./launch-on-call";

let registered = false;

export function registerRoamTools(
  launchApp: (appId: string) => Promise<void>,
  registry: ToolRegistry = toolRegistry,
): void {
  if (registered) return;
  registered = true;

  registry.registerSystemTool(
    {
      name: "roam.add_todo",
      description:
        "Add a TODO item to the user's Roam Research daily notes page (their main todo list). Opens the Roam app on the glasses.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "The todo item's text." } },
        required: ["text"],
        additionalProperties: false,
      },
      timeoutMs: 25_000,
    },
    async (args) => {
      const text = String(args?.text ?? "").trim();
      if (!text) return err("roam.add_todo requires text");
      return callAppTool(launchApp, registry, "add_todo", { text });
    },
  );

  registry.registerSystemTool(
    {
      name: "roam.read_todos",
      description:
        "Read the user's Roam Research daily notes page, including their todo list with each item's done/open state. Opens the Roam app on the glasses.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: 25_000,
    },
    async () => callAppTool(launchApp, registry, "read_page", {}),
  );
}

/** Check Roam configuration, then launch-on-call forward to the Roam app. */
async function callAppTool(
  launchApp: (appId: string) => Promise<void>,
  registry: ToolRegistry,
  unprefixedName: string,
  args: unknown,
): Promise<ToolResult> {
  if (roamGraphNameSetting.get().length === 0 || roamApiTokenSetting.get().length === 0) {
    return err("Roam is not configured; the user must set the graph name and API token from the Roam app's long-press menu.");
  }
  return callAppToolWithLaunch(registry, launchApp, "roam", unprefixedName, args);
}

function err(error: string): ToolResult {
  return { ok: false, error };
}
