import { type AppDefinition } from "../app-definition";
import { ASIDE_SURFACE_ID, ASIDE_WINDOW_ID, createAsideAppWindow } from "./aside-app";

const asideApp: AppDefinition = {
  appId: "aside",
  title: "Aside",
  icon: "lightbulb",
  // Reopening would start listening to the people nearby without being asked.
  restoreOnRestart: false,
  launch: (ctx) =>
    ctx.launchInProcessApp(ASIDE_WINDOW_ID, ASIDE_SURFACE_ID, (options) =>
      createAsideAppWindow({
        ...options,
        startContinuousVoiceCapture: () => void options.actions.startContinuousVoiceCapture("aside"),
        stopContinuousVoiceCapture: () => void options.actions.stopContinuousVoiceCapture("aside"),
        requestShellRender: ctx.requestShellRender,
      }),
    ),
};

export default asideApp;
