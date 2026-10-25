import { inProcessTrayWidget, type AppDefinition } from "../app-definition";
import { createNightscoutAppWindow, startNightscoutTrayIcon, NIGHTSCOUT_SURFACE_ID, NIGHTSCOUT_WINDOW_ID } from "./nightscout-app";
import { startMissedBolusMonitor } from "./missed-bolus-monitor";

const nightscoutApp: AppDefinition = {
  appId: "nightscout",
  title: "Nightscout",
  icon: "nightscout",
  boot: (ctx) => {
    // Selected in the switcher, the tray readout shows the app's window.
    startNightscoutTrayIcon(
      inProcessTrayWidget(ctx, NIGHTSCOUT_WINDOW_ID, NIGHTSCOUT_SURFACE_ID, createNightscoutAppWindow),
    );
    startMissedBolusMonitor(ctx);
  },
  launch: (ctx) => ctx.launchInProcessApp(NIGHTSCOUT_WINDOW_ID, NIGHTSCOUT_SURFACE_ID, createNightscoutAppWindow),
};

export default nightscoutApp;
