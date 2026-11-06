import { glassesHaveCompass } from "../../ui/dashboard-settings";
import { type AppDefinition } from "../app-definition";
import { COMPASS_SURFACE_ID, COMPASS_WINDOW_ID, createCompassAppWindow } from "./compass-app";

const compassApp: AppDefinition = {
  appId: "compass",
  title: "Compass",
  icon: "compass",
  isSupported: glassesHaveCompass,
  launch: (ctx) => ctx.launchInProcessApp(COMPASS_WINDOW_ID, COMPASS_SURFACE_ID, createCompassAppWindow),
};

export default compassApp;
