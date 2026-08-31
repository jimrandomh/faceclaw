import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";

const blocksApp: AppDefinition = {
  appId: "blocks",
  title: "Blocks",
  icon: "l-piece",
  launch: (ctx) =>
    launchWorkerAppWindow(ctx, {
      createWorker: () => new Worker("./blocks-app.worker"),
      windowId: "blocks:main",
      title: "Blocks",
      iconLetter: "B",
      icon: "l-piece",
      acceptsDirectional: true,
    }),
};

export default blocksApp;
