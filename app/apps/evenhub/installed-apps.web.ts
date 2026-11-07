/** EvenHub apps need the phones' WebView host: nothing can be installed in the browser demo, so nothing ever is. */
import type { GrayImage } from "../../graphics/image";
import type { EvenHubManifest } from "./ehpk";

export type InstalledEvenHubApp = { packageId: string; name: string; version: string; installedAt: number; iconFile?: string };

export function getInstalledEvenHubApps(): InstalledEvenHubApp[] { return []; }
export function installedEvenHubAppId(packageId: string): string { return `evenhub:${packageId}`; }
export function renderInstalledEvenHubIcon(_packageId: string, _size: number, _app?: unknown): GrayImage | null { return null; }
export function readEvenHubPackageManifest(_path: string): EvenHubManifest | null { return null; }
export function installEvenHubPackageFile(_path: string): InstalledEvenHubApp {
  throw new Error("EvenHub apps can't be installed in the browser demo");
}
