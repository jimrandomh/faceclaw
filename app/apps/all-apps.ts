import { type AppDefinition } from "./app-definition";
import launcherApp from "./launcher";
import timerApp from "./timer";
import calculatorApp from "./calculator";
import terminalApp from "./terminal";
import filesApp from "./files";
import musicApp from "./music";
import nightscoutApp from "./nightscout";
import transcribeApp from "./transcribe";
import microphonesApp from "./microphones";
import notificationsApp from "./notifications";
import calendarApp from "./calendar";
import weatherApp from "./weather";
import navigateApp from "./navigate";
import compassApp from "./compass";
import roamApp from "./roam";
import blocksApp from "./blocks";
import minesweeperApp from "./minesweeper";
import freecellApp from "./freecell";
import pinballApp from "./pinball";
import developerApp from "./developer";
import evenhubApp from "./evenhub";
import settingsApp from "./settings";

/**
 * Every app, in launcher-grid order (the launcher itself is first but hidden
 * from the grid). The sole registry: the controller, launcher, and assistant
 * tools all discover apps here.
 */
export const ALL_APPS: readonly AppDefinition[] = [
  launcherApp,
  timerApp,
  calculatorApp,
  terminalApp,
  filesApp,
  musicApp,
  nightscoutApp,
  transcribeApp,
  microphonesApp,
  notificationsApp,
  calendarApp,
  weatherApp,
  navigateApp,
  compassApp,
  roamApp,
  blocksApp,
  minesweeperApp,
  freecellApp,
  pinballApp,
  developerApp,
  evenhubApp,
  settingsApp,
];
