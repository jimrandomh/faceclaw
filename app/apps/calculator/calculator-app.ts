/**
 * Calculator window wiring: the in-process window, its long-press menu (mode
 * follow-ups, clear, settings), the assistant tools, and the voice/text
 * plumbing into the layer.
 *
 * The coordinator is a module singleton on purpose: a
 * problem stated through the assistant's calculate tool is still standing
 * when the wearer opens the window, and "graph it" there refers to it. The
 * same session also survives closing and reopening the window.
 */
import {
  createInProcessWindow,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { type MenuItem } from "../../ui/menu";
import { openSettingsSubMenu } from "../../ui/dashboard/settings-panel";
import { enumSettingMenuItem, toggleSettingMenuItem } from "../../ui/dashboard-settings";
import { shell } from "../../ui/shell/shell";
import { toolRegistry } from "../../assistant/tool-registry";
import { type ToolSpec } from "../../assistant/tool-registry";
import { MathCoordinator } from "./math/coordinator";
import { rewriteSpokenProblem } from "./calculator-llm";
import {
  CalculatorLayer,
  calculatorDegreesSetting,
  calculatorListeningSetting,
  calculatorModeSetting,
} from "./calculator";
import { CALCULATOR_MODES, modeLabel } from "./calculator-commands";

export const CALCULATOR_WINDOW_ID = "calculator";
export const CALCULATOR_SURFACE_ID = "window:calculator";

/** One standing maths session, shared by the window and the assistant tools. */
const coordinator = new MathCoordinator();
coordinator.setAICompletion(rewriteSpokenProblem);

const CALCULATOR_TOOLS: ToolSpec[] = [
  {
    name: "calculate",
    description:
      "Solve a maths problem stated in words or notation ('2x + 7 = 19', 'what is 15 percent of 240', " +
      "'is 91 prime', 'where does 11 first appear in pi', 'area of a circle with radius 3'). " +
      "Do NOT work it out yourself first — hand the words over verbatim; the calculator answers " +
      "exactly and shows the result on the glasses. Follow-ups like 'graph it' and 'explain it' " +
      "act on the problem already standing.",
    inputSchema: {
      type: "object",
      properties: {
        problem: { type: "string", description: "The problem or follow-up, exactly as asked." },
      },
      required: ["problem"],
      additionalProperties: false,
    },
    availability: "open",
  },
];

export function createCalculatorAppWindow(options: InProcessAppOptions): InProcessWindow {
  const layer = new CalculatorLayer(coordinator, options.actions);

  const menuItems = (): MenuItem[] => [
    ...CALCULATOR_MODES.map(
      (mode): MenuItem => ({
        label: `${modeLabel(mode)} it`,
        onSelect: (ctx) => {
          ctx.stack.pop();
          layer.performFollowUp(mode);
        },
      }),
    ),
    {
      label: "Clear",
      onSelect: (ctx) => {
        ctx.stack.pop();
        layer.clear();
      },
    },
    {
      label: "Calculator settings",
      onSelect: (ctx) => {
        ctx.stack.pop();
        openSettingsSubMenu(ctx, "Calculator settings", [
          enumSettingMenuItem(calculatorModeSetting, {
            onChange: () => layer.applySettings(),
          }),
          enumSettingMenuItem(calculatorListeningSetting, {
            onChange: () => layer.applySettings(),
          }),
          toggleSettingMenuItem(calculatorDegreesSetting, {
            onChange: () => layer.applySettings(),
          }),
        ]);
      },
    },
  ];

  let app: InProcessWindow;
  app = createInProcessWindow({
    appId: "calculator",
    windowId: CALCULATOR_WINDOW_ID,
    title: "Calculator",
    iconLetter: "=",
    icon: "calculator",
    closeable: true,
    menuItems,
    actions: options.actions,
    receiveTextInput: (text) => {
      if (app.stack.receiveTextInput(text)) app.requestRender();
    },
    baseLayer: layer,
    submitFrame: options.submitFrame,
    setSurfaceVisible: (visible) => {
      layer.setForeground(visible);
      options.setSurfaceVisible(visible);
    },
    removeSurface: options.removeSurface,
    onClosed: () => {
      toolRegistry.removeAppTools(CALCULATOR_WINDOW_ID);
      options.onClosed();
    },
  });
  layer.requestRender = app.requestRender;
  layer.setForeground(shell.isWindowVisible(CALCULATOR_WINDOW_ID));
  // Apply the persisted settings now the window exists: degrees onto the
  // session, and continuous listening if the wearer left it on.
  layer.applySettings();

  toolRegistry.setAppTools({
    windowId: CALCULATOR_WINDOW_ID,
    appId: "calculator",
    specs: CALCULATOR_TOOLS,
    isForeground: () => shell.isWindowFocused(CALCULATOR_WINDOW_ID),
    invoke: async (toolName, args) => {
      if (toolName !== "calculate") {
        return { ok: false, error: `Unknown calculator tool: ${toolName}` };
      }
      const problem = String((args as { problem?: unknown })?.problem ?? "").trim();
      if (!problem) return { ok: false, error: "calculate requires a problem" };
      const outcome = await coordinator.answerSpoken(problem);
      app.requestRender();
      if (outcome.kind === "failure") return { ok: false, error: outcome.reason };
      const detail = coordinator.lastResult?.detail ?? "";
      return { ok: true, content: detail || outcome.text };
    },
  });

  return app;
}
