import { type AppDefinition } from "../app-definition";
import { createTeleprompterAppWindow, TELEPROMPTER_SURFACE_ID, TELEPROMPTER_WINDOW_ID } from "./teleprompter-app";

const teleprompterApp: AppDefinition = {
  appId: "teleprompter",
  title: "Teleprompter",
  icon: "scroll-text",
  launch: (ctx) =>
    ctx.launchInProcessApp(TELEPROMPTER_WINDOW_ID, TELEPROMPTER_SURFACE_ID, (options) =>
      createTeleprompterAppWindow({
        ...options,
        startContinuousVoiceCapture: () => void options.actions.startContinuousVoiceCapture(),
        stopContinuousVoiceCapture: () => void options.actions.stopContinuousVoiceCapture(),
        appendLog: (message) => ctx.appendLog(message),
      }),
    ),
};

export default teleprompterApp;
