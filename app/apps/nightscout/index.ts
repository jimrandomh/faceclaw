import { type AppDefinition } from "../app-definition";
import { createNightscoutAppWindow, startNightscoutTrayIcon, NIGHTSCOUT_SURFACE_ID, NIGHTSCOUT_WINDOW_ID } from "./nightscout-app";

const nightscoutApp: AppDefinition = {
  appId: "nightscout",
  title: "Nightscout",
  icon: "nightscout",
  boot: () => startNightscoutTrayIcon(),
  launch: (ctx) => ctx.launchInProcessApp(NIGHTSCOUT_WINDOW_ID, NIGHTSCOUT_SURFACE_ID, createNightscoutAppWindow),
};

export default nightscoutApp;
