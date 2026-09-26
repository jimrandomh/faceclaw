import { ensureFineLocationPermission } from "../../native/location-permissions";
import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";

const navigateApp: AppDefinition = {
  appId: "navigate",
  title: "Navigate",
  icon: "map",
  launch: (ctx) => {
    // Navigation needs precise location; prompt on the phone while the
    // window opens (the worker can't show permission dialogs).
    void ensureFineLocationPermission().catch(() => {});
    return launchWorkerAppWindow(ctx, {
      createWorker: () => new Worker("./navigate-app.worker"),
      windowId: "navigate:main",
      title: "Navigate",
      iconLetter: "N",
      icon: "map",
    });
  },
};

export default navigateApp;
