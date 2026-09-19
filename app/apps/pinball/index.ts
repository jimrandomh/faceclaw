import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";

const pinballApp: AppDefinition = {
  appId: "pinball",
  title: "Pinball",
  icon: "pinball",
  launch: (ctx) =>
    launchWorkerAppWindow(ctx, {
      createWorker: () => new Worker("./pinball-app.worker"),
      windowId: "pinball:main",
      title: "Pinball",
      iconLetter: "P",
      icon: "pinball",
      acceptsDirectional: true,
    }),
};

export default pinballApp;
