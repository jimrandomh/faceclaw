import { TextViewerLayer } from "./files/text-viewer";
import { createInProcessWindow, YieldAtRootLayer } from "../ui/shell/in-process-window";
import type { IconName } from "../graphics/icons";
import { nightscoutBridge } from "../native/nightscout-bridge";
import { nightscoutApiTokenSetting, nightscoutSiteUrlSetting } from "../ui/dashboard-settings";
import { DEMO_NIGHTSCOUT_TOKEN, DEMO_NIGHTSCOUT_URL } from "../web/demo-data/nightscout";
import { type AppDefinition } from "./app-definition";
import terminalApp from "./terminal";
import launcherApp from "./launcher";
import timerApp from "./timer";
import calculatorApp from "./calculator";
import filesApp from "./files";
import musicApp from "./music";
import nightscoutApp from "./nightscout";
import healthApp from "./health";
import teleprompterApp from "./teleprompter";
import notificationsApp from "./notifications";
import calendarApp from "./calendar";
import weatherApp from "./weather";
import compassApp from "./compass";
import blocksApp from "./blocks";
import minesweeperApp from "./minesweeper";
import freecellApp from "./freecell";
import pinballApp from "./pinball";
import flappyApp from "./flappy";
import glanceboardApp from "./glanceboard";
import settingsApp from "./settings";
import onboardingApp from "./onboarding";

/**
 * An app the browser demo can't run, kept in the grid because it is part of what
 * Faceclaw is: opening it says what it does and why it isn't here. Registering
 * these instead of the real apps also keeps their native dependencies (microphone
 * pipelines, WebViews, on-device models) out of the bundle.
 */
function phoneOnlyApp(appId: string, title: string, icon: IconName, description: string): AppDefinition {
  return {
    appId,
    title,
    icon,
    launch: (ctx) => ctx.launchInProcessApp(appId, `window:${appId}`, (options) => createInProcessWindow({
      ...options,
      appId,
      windowId: appId,
      title,
      icon,
      iconLetter: title[0]!,
      closeable: true,
      baseLayer: new YieldAtRootLayer(new TextViewerLayer(`${description}\n\nThis one needs the real thing, so it isn't part of the browser demo.`, title)),
    })),
  };
}

/**
 * Nightscout comes up on the sample server the first time it's opened, not at
 * boot, so the status bar only shows a glucose reading to people who asked.
 */
const demoNightscoutApp: AppDefinition = {
  ...nightscoutApp,
  launch: async (ctx, params) => {
    if (!nightscoutSiteUrlSetting.get()) {
      nightscoutSiteUrlSetting.set(DEMO_NIGHTSCOUT_URL);
      nightscoutApiTokenSetting.set(DEMO_NIGHTSCOUT_TOKEN);
      await nightscoutBridge.refreshNow();
    }
    await nightscoutApp.launch(ctx, params);
  },
};

/** Grid order follows all-apps.ts. */
export const ALL_APPS: readonly AppDefinition[] = [
  launcherApp,
  phoneOnlyApp("ai-chat", "AI Chat", "message-circle", "Talk to an assistant by voice, with Claude, GPT or a model running on your phone."),
  timerApp,
  calculatorApp,
  terminalApp,
  phoneOnlyApp("t3code", "T3 Code", "t3code", "Follow and approve your coding agent's work from T3 Code, with voice replies."),
  filesApp,
  musicApp,
  demoNightscoutApp,
  healthApp,
  phoneOnlyApp("transcribe", "Transcribe", "mic", "Live captions of what's being said around you, through the glasses' microphones."),
  phoneOnlyApp("translate", "Translate", "languages", "Live translated captions of a conversation, through the glasses' microphones."),
  teleprompterApp,
  phoneOnlyApp("microphones", "Microphones", "mic", "Who's talking and from where: speaker-labeled captions using the glasses' microphones."),
  notificationsApp,
  calendarApp,
  weatherApp,
  phoneOnlyApp("navigate", "Navigate", "map", "Turn-by-turn walking directions with a map, using your phone's GPS."),
  compassApp,
  phoneOnlyApp("roam", "Roam", "roam", "Read and add to your Roam Research graph by voice."),
  blocksApp,
  minesweeperApp,
  freecellApp,
  pinballApp,
  flappyApp,
  phoneOnlyApp("developer", "Developer", "wrench", "Debug tools for the display, the ring and Bluetooth, and a loader for EvenHub apps in development."),
  phoneOnlyApp("evenhub", "EvenHub", "package", "Install and run apps from Even Realities' EvenHub store."),
  glanceboardApp,
  settingsApp,
  onboardingApp,
];
