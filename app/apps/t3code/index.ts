import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";
import { onSettingsStoreChanged } from "../../native/settings-store";
import { hasT3BackgroundWork } from "./background";
import { T3_ENVIRONMENTS_KEY } from "./t3-environments";

/** The one place the worker is constructed (string-literal path for the webpack worker loader). */
const createWorker = () => new Worker("./t3code-app.worker");

/** The boot hook's settings listener; replaced if a controller boots again. */
let stopWatchingSettings: (() => void) | null = null;

const t3codeApp: AppDefinition = {
  appId: "t3code",
  title: "T3 Code",
  icon: "t3code",
  launch: (ctx) =>
    launchWorkerAppWindow(ctx, {
      createWorker,
      windowId: "t3code:main",
      title: "T3 Code",
      iconLetter: "T3",
      icon: "t3code",
    }),
  /**
   * The Glanceboard's T3 Code widget shows what this app's worker knows, so
   * start the worker (windowless) whenever the widget is in use: at startup,
   * and when the widget, the board, or the paired environments change. The
   * worker reports idle by itself once nothing needs it.
   */
  boot: (ctx) => {
    const ensureWorker = () => {
      if (hasT3BackgroundWork()) ctx.ensureWorkerHost(createWorker);
    };
    ensureWorker();
    stopWatchingSettings?.();
    stopWatchingSettings = onSettingsStoreChanged((key) => {
      if (key.startsWith("glanceboard.") || key === T3_ENVIRONMENTS_KEY) ensureWorker();
    });
  },
};

export default t3codeApp;
