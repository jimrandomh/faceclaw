import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";

const flappyApp: AppDefinition = {
  appId: "flappy",
  title: "Flappy",
  icon: "bird",
  launch: (ctx) =>
    launchWorkerAppWindow(ctx, {
      createWorker: () => new Worker("./flappy-app.worker"),
      windowId: "flappy:main",
      title: "Flappy",
      iconLetter: "B",
      icon: "bird",
      acceptsDirectional: true,
    }),
};

export default flappyApp;
