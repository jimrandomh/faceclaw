/**
 * Page entry point. Nothing may import the app before the files its modules read
 * while evaluating are in memory (fonts, mostly), so the app is required
 * afterwards. See README.md in this directory.
 */
import { openPersistentDocuments, preloadAssets } from "./vfs";
import "./workers";

/** What the launcher reads while starting. Everything else arrives on demand, by synchronous XHR. */
const BOOT_ASSETS = ["fonts/ttf/Roboto-Light.ttf", "fonts/ttf/Roboto-Regular.ttf"];

async function boot(): Promise<void> {
  await Promise.all([openPersistentDocuments(), preloadAssets(BOOT_ASSETS)]);
  const { startPage } = require("./page") as typeof import("./page");
  startPage();
}

boot().catch((error) => {
  console.error(error);
  const status = document.getElementById("status");
  if (status) status.textContent = `Couldn't start: ${error}`;
});
