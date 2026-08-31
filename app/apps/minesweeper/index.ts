import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";

const minesweeperApp: AppDefinition = {
  appId: "minesweeper",
  title: "Minesweeper",
  icon: "bomb",
  launch: (ctx) =>
    launchWorkerAppWindow(ctx, {
      createWorker: () => new Worker("./minesweeper-app.worker"),
      windowId: "minesweeper:main",
      title: "Minesweeper",
      iconLetter: "M",
      icon: "bomb",
      acceptsDirectional: true,
    }),
};

export default minesweeperApp;
