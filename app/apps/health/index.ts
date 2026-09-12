import { type AppDefinition } from "../app-definition";
import { createHealthAppWindow, HEALTH_SURFACE_ID, HEALTH_WINDOW_ID } from "./health-app";

const healthApp: AppDefinition = {
  appId: "health",
  title: "Health",
  icon: "activity",
  launch: (ctx) => ctx.launchInProcessApp(HEALTH_WINDOW_ID, HEALTH_SURFACE_ID, createHealthAppWindow),
};

export default healthApp;
