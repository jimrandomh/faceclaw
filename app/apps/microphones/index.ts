import { type AppDefinition } from "../app-definition";
import {
  createMicrophonesAppWindow,
  MICROPHONES_SURFACE_ID,
  MICROPHONES_WINDOW_ID,
} from "./microphones-app";
import { micSession } from "./mic-session";

/**
 * The Microphones app: per-mic control and levels, the Sonic Radar
 * (direction-of-arrival + beam-filtered listening), and live captions with
 * speaker recognition, translation, and tone analysis. Saved conversations
 * are reviewed in the phone UI.
 */
const microphonesApp: AppDefinition = {
  appId: "microphones",
  title: "Microphones",
  icon: "mic",
  boot: () => {
    // Prune expired captions/recordings per the retention settings.
    void micSession.applyRetentionSweep();
  },
  launch: async (ctx) => {
    await ctx.launchInProcessApp(MICROPHONES_WINDOW_ID, MICROPHONES_SURFACE_ID, (options) =>
      createMicrophonesAppWindow(options),
    );
  },
};

export default microphonesApp;
