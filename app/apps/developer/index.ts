import { type AppDefinition } from "../app-definition";
import { createDeveloperAppWindow, DEVELOPER_SURFACE_ID, DEVELOPER_WINDOW_ID } from "./developer-app";

const developerApp: AppDefinition = {
  appId: "developer",
  title: "Developer",
  icon: "wrench",
  launch: (ctx) =>
    ctx.launchInProcessApp(DEVELOPER_WINDOW_ID, DEVELOPER_SURFACE_ID, (options) =>
      createDeveloperAppWindow(ctx, options),
    ),
};

export default developerApp;
