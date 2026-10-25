import { type AppDefinition } from "../app-definition";
import { createTranslateAppWindow, TRANSLATE_SURFACE_ID, TRANSLATE_WINDOW_ID } from "./translate-app";

const translateApp: AppDefinition = {
  appId: "translate",
  title: "Translate",
  icon: "languages",
  launch: (ctx) =>
    ctx.launchInProcessApp(TRANSLATE_WINDOW_ID, TRANSLATE_SURFACE_ID, (options) =>
      createTranslateAppWindow({
        ...options,
        startContinuousVoiceCapture: (capture) => void options.actions.startContinuousVoiceCapture("translate", capture),
        stopContinuousVoiceCapture: () => void options.actions.stopContinuousVoiceCapture("translate"),
      }),
    ),
};

export default translateApp;
