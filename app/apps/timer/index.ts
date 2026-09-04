import { type AppDefinition } from "../app-definition";
import { shell } from "../../ui/shell/shell";
import { registerTimerTools } from "../../assistant/timer-tools";
import { timerEngine, timersWakeSetting } from "./timer-engine";
import { createTimerAppWindow, startTimersTrayIcon, TIMER_SURFACE_ID, TIMER_WINDOW_ID } from "./timer-app";

/**
 * Timers, stopwatch and alarms. The clock engine boots with the shell so
 * timers and alarms fire (and the assistant's timer.* / alarm.* tools work)
 * with no window open; launching only opens the view on it.
 */
const timerApp: AppDefinition = {
  appId: "timer",
  title: "Timers",
  icon: "timer",
  boot: (ctx) => {
    timerEngine.boot({
      playBuzzer: (payload) => ctx.actions.playBuzzerSequence(payload),
      onRing: () => {
        // Bring the ringing item on screen: focus the Timers window, then
        // wake the display if it is off (a setting, since a wearer may
        // prefer the phone notification alone while the glasses sleep).
        void ctx
          .launchApp("timer")
          .then(() => {
            if (timersWakeSetting.get() && !shell.isScreenOn()) shell.wake("window");
          })
          .catch((error) => console.error(`timers ring launch failed: ${error}`));
      },
    });
    startTimersTrayIcon();
    registerTimerTools((appId) => ctx.launchApp(appId));
  },
  launch: (ctx) => ctx.launchInProcessApp(TIMER_WINDOW_ID, TIMER_SURFACE_ID, createTimerAppWindow),
};

export default timerApp;
