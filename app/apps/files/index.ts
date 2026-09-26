import { type AppContext, type AppDefinition } from "../app-definition";
import { openEvenHubPackage } from "../evenhub";
import {
  installEvenHubPackageFile,
  installedEvenHubAppId,
} from "../evenhub/installed-apps";
import { closeRunningPackage } from "../evenhub/manager";
import {
  createFilesAppWindow,
  createFontDocumentWindow,
  createImageDocumentWindow,
  createTextDocumentWindow,
  FILES_SURFACE_ID,
  FILES_WINDOW_ID,
} from "./files-app";

// Document windows are closeable and non-singleton; the serial keeps their
// windowIds unique.
let nextDocumentSerial = 1;

function openTextDocumentWindow(ctx: AppContext, title: string, text: string): void {
  const windowId = `files:doc:${nextDocumentSerial++}`;
  void ctx
    .launchInProcessApp(windowId, `window:${windowId}`, (options) =>
      createTextDocumentWindow(windowId, title, text, options),
    )
    .catch((error) => {
      ctx.appendLog(`text document window failed: ${error}`);
    });
}

function openImageDocumentWindow(ctx: AppContext, title: string, path: string): void {
  const windowId = `files:doc:${nextDocumentSerial++}`;
  void ctx
    .launchInProcessApp(windowId, `window:${windowId}`, (options) =>
      createImageDocumentWindow(windowId, title, path, options),
    )
    .catch((error) => {
      ctx.appendLog(`image window failed: ${error}`);
    });
}

function openFontDocumentWindow(ctx: AppContext, title: string, path: string): void {
  const windowId = `files:doc:${nextDocumentSerial++}`;
  void ctx
    .launchInProcessApp(windowId, `window:${windowId}`, (options) =>
      createFontDocumentWindow(windowId, title, path, options),
    )
    .catch((error) => {
      ctx.appendLog(`font preview window failed: ${error}`);
    });
}

const filesApp: AppDefinition = {
  appId: "files",
  title: "Files",
  icon: "folder",
  launch: (ctx) =>
    ctx.launchInProcessApp(FILES_WINDOW_ID, FILES_SURFACE_ID, (options) =>
      createFilesAppWindow({
        ...options,
        openDocumentWindow: (title, text) => openTextDocumentWindow(ctx, title, text),
        openImageWindow: (title, path) => openImageDocumentWindow(ctx, title, path),
        openEhpkApp: (path) => {
          void openEvenHubPackage(ctx, path).catch((error) => {
            ctx.appendLog(`evenhub launch failed: ${error}`);
            openTextDocumentWindow(ctx, 'Could not run app', String(error));
          });
        },
        installEhpkApp: async (path) => {
          try {
            const installed = installEvenHubPackageFile(path);
            ctx.appendLog(`evenhub: installed ${installed.packageId} ${installed.version}`);
            closeRunningPackage(installed.packageId);
            await ctx.launchApp(installedEvenHubAppId(installed.packageId));
          } catch (error) {
            ctx.appendLog(`evenhub install failed: ${error}`);
          }
        },
        openFontWindow: (title, path) => openFontDocumentWindow(ctx, title, path),
      }),
    ),
  // A document arriving via Android's Share intent opens as its own window.
  openSharedText: (ctx, title, text) => openTextDocumentWindow(ctx, title, text),
};

export default filesApp;
