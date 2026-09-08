/**
 * Registry of running EvenHub apps. Each launched package gets its own glasses
 * window, session, and persistent WebView — they run concurrently and keep
 * driving their windows in the background (the shell delivers FOREGROUND_ENTER/
 * EXIT as focus changes; the WebView host keeps them rendering while unseen).
 *
 * Glasses-first: launching does NOT take over the phone screen. The phone
 * stays on the Faceclaw dashboard; an app's phone UI is shown on demand
 * (window menu -> "Show phone UI"), overlaying the dashboard, and the Back
 * button returns to it. Apps are kept alive until explicitly closed (no memory
 * eviction yet).
 */
import { Application } from "@nativescript/core";
import { type AppContext } from "../app-definition";
import {
  appFilesDirPath,
  deletePathRecursively,
  readBinaryFile,
  writeBinaryFile,
} from "../../native/file-access";
import { parseEhpk, parseManifest, utf8Decode, type EvenHubManifest } from "./ehpk";
import { type EvenHubPermission } from "./permissions";
import { EvenHubSession } from "./session";
import { createEvenHubWindow } from "./evenhub-window";
import { createEvenHubWebView, type EvenHubWebView } from "./webview";
import { shell } from "../../ui/shell/shell";
import {
  installedEvenHubAppId,
  installedEvenHubPackagePath,
  type InstalledEvenHubApp,
} from "./installed-apps";

type RunningApp = {
  windowId: string;
  appId: string;
  packageId: string;
  session: EvenHubSession;
  webView: EvenHubWebView;
};

const running = new Map<string, RunningApp>();
let nextSerial = 1;
let phoneShownWindowId: string | null = null;
let backHandlerRegistered = false;

/** Intercept Android Back while an app's phone UI is overlaying the dashboard. */
function ensureBackHandler(): void {
  if (backHandlerRegistered) return;
  backHandlerRegistered = true;
  Application.android?.on("activityBackPressed", (args: { cancel: boolean }) => {
    if (phoneShownWindowId) {
      args.cancel = true;
      hidePhone();
    }
  });
}

/**
 * Unpack an .ehpk and launch it as a new concurrent app: a glasses window plus
 * a persistent WebView. Does not disturb other running apps or the phone screen.
 */
export async function launchPackage(
  ctx: AppContext,
  ehpkPath: string,
  options: { appId?: string; singleton?: boolean } = {},
): Promise<void> {
  const data = readBinaryFile(ehpkPath);
  if (!data) {
    throw new Error('Could not read the EHPK file.');
  }
  const archive = parseEhpk(data);
  const appJson = archive.files.get("app.json");
  if (!appJson) {
    throw new Error('The EHPK package has no app.json.');
  }
  const manifest = parseManifest(utf8Decode(appJson));
  if (!archive.files.has(`dist/${manifest.entrypoint}`)) throw new Error('The EHPK entrypoint is missing from dist/.');
  const appId = options.appId ?? "evenhub";
  if (options.singleton) {
    const existing = Array.from(running.values()).find((app) => app.appId === appId);
    if (existing) {
      shell.focusWindow(existing.windowId);
      ctx.requestShellRender();
      return;
    }
  }

  // Unpack fresh into app-private storage, keyed by package id.
  const safeId = manifest.packageId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safeId || safeId === '.' || safeId === '..') throw new Error('Invalid EHPK package ID');
  const baseDir = `${appFilesDirPath()}/evenhub-apps/${safeId}${global.isIOS ? `-${Date.now()}-${nextSerial}` : ''}`;
  deletePathRecursively(baseDir);
  for (const [name, content] of Array.from(archive.files)) {
    if (!writeBinaryFile(`${baseDir}/${name}`, content)) {
      deletePathRecursively(baseDir);
      throw new Error(`Could not unpack ${name}.`);
    }
  }

  try { await startApp(ctx, manifest, `${baseDir}/dist`, "", appId, global.isIOS ? () => deletePathRecursively(baseDir) : undefined); }
  catch (error) { deletePathRecursively(baseDir); throw error; }
}

/**
 * Shared tail of every launch: build the session and its WebView, register the
 * pair, and open the glasses window. `distDir` serves a packaged app offline;
 * `remoteUrl`, when set, loads the app from the network instead.
 */
async function startApp(
  ctx: AppContext,
  manifest: EvenHubManifest,
  distDir: string,
  remoteUrl: string,
  appId: string,
  cleanup?: () => void,
): Promise<void> {
  const windowId = `evenhub:app:${nextSerial++}`;
  const session = new EvenHubSession(manifest, distDir, ctx.appendLog, remoteUrl);
  const webView = createEvenHubWebView(session);
  session.attachWebView({
    evaluateJs: webView.evaluateJs,
    destroy: () => {
      if (phoneShownWindowId === windowId) {
        webView.hideOnPhone();
        phoneShownWindowId = null;
      }
      webView.destroy();
      cleanup?.();
      running.delete(windowId);
    },
  });
  running.set(windowId, { windowId, appId, packageId: manifest.packageId, session, webView });
  ensureBackHandler();
  ctx.appendLog(`evenhub: launching ${manifest.name} ${manifest.version} (${manifest.packageId})`);

  try {
    await ctx.launchInProcessApp(windowId, `window:${windowId}`, (options) =>
      createEvenHubWindow(windowId, appId, session, options, () => showOnPhone(windowId)),
    );
  } catch (error) { session.close(); throw error; }
}

/**
 * Launch an EvenHub app served by a live web server (the Developer app's
 * "Load app from URL" / QR flows), rather than one unpacked from an .ehpk.
 *
 * There is no manifest to read, so one is synthesized: the URL identifies the
 * app (a stable packageId keeps its localStorage across reloads) and every
 * permission is treated as declared, on the grounds that the user pointed
 * Faceclaw at this URL themselves. Loading the same URL again replaces the
 * running instance, which is what a reload after an edit should do.
 */
export async function launchUrl(ctx: AppContext, url: string): Promise<void> {
  const normalized = normalizeAppUrl(url);
  if (!normalized) {
    ctx.appendLog(`evenhub: not an http(s) URL: ${url}`);
    throw new Error("Not an http:// or https:// URL.");
  }
  const manifest = synthesizeUrlManifest(normalized);
  closeRunningPackage(manifest.packageId);
  await startApp(ctx, manifest, "", normalized, "evenhub");
}

/** Accept a bare "example.com/app" as https; reject anything not http(s). */
export function normalizeAppUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!/^https?:\/\/[^/?#\s]+/i.test(withScheme)) return null;
  return withScheme;
}

/** Every permission name the host knows how to honor, granted to URL apps. */
const DEV_URL_PERMISSIONS: EvenHubPermission[] = [
  { name: "network" },
  { name: "location" },
  { name: "g2-microphone" },
  { name: "phone-microphone" },
];

function synthesizeUrlManifest(url: string): EvenHubManifest {
  const match = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  const authority = match?.[1] ?? url;
  const path = (match?.[2] ?? "").replace(/\/index\.html?$/i, "").replace(/\/+$/, "");
  const idSource = `${authority}${path}`.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  return {
    packageId: `dev.url.${idSource.slice(0, 96)}`,
    name: authority,
    version: "dev",
    entrypoint: "",
    networkWhitelist: [],
    permissions: DEV_URL_PERMISSIONS,
    privacyPolicyUrl: "",
    raw: { url },
  };
}

/** Launch an installed app as a launcher-addressable singleton. */
export function launchInstalledPackage(ctx: AppContext, app: InstalledEvenHubApp): Promise<void> {
  return launchPackage(ctx, installedEvenHubPackagePath(app.packageId), {
    appId: installedEvenHubAppId(app.packageId),
    singleton: true,
  });
}

/** Close every running instance before an installed package is removed. */
export function closeRunningPackage(packageId: string): void {
  const windowIds = Array.from(running.values())
    .filter((app) => app.packageId === packageId)
    .map((app) => app.windowId);
  for (const windowId of windowIds) shell.closeWindow(windowId);
}

/** Overlay one app's phone UI over the dashboard (from its window menu). */
export function showOnPhone(windowId: string): void {
  const app = running.get(windowId);
  if (!app) return;
  if (phoneShownWindowId && phoneShownWindowId !== windowId) hidePhone();
  app.webView.showOnPhone();
  phoneShownWindowId = windowId;
}

/** Return the phone to the dashboard (Back, or the shown app closing). */
export function hidePhone(): void {
  if (!phoneShownWindowId) return;
  running.get(phoneShownWindowId)?.webView.hideOnPhone();
  phoneShownWindowId = null;
}

export function runningAppCount(): number {
  return running.size;
}
