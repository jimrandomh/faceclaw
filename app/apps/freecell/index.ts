import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";

const freecellApp: AppDefinition = {
  appId: "freecell",
  title: "Freecell",
  icon: "spade",
  launch: (ctx) =>
    launchWorkerAppWindow(ctx, {
      createWorker: () => new Worker("./freecell-app.worker"),
      windowId: "freecell:main",
      title: "Freecell",
      iconLetter: "F",
      icon: "spade",
      acceptsDirectional: true,
    }),
};

export default freecellApp;
