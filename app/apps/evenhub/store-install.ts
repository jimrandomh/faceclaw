/**
 * The storefront install pipeline shared by the app detail page and the
 * Updates tab: download the package and its icon, confirm permissions when
 * that is warranted, close running instances, and store the package.
 */
import { type LayerContext } from "../../ui/layers";
import { evenHubApi, type EvenHubStoreApp } from "./even-api";
import { type EvenHubManifest } from "./ehpk";
import {
  installEvenHubPackageBytes,
  installedEvenHubPackagePath,
  readEvenHubPackageManifest,
  readEvenHubPackageManifestBytes,
  type InstalledEvenHubApp,
} from "./installed-apps";
import { closeRunningPackage } from "./manager";
import { EvenHubPermissionDialogLayer } from "./permission-dialog";

export type StoreInstallOptions = {
  appendLog: (message: string) => void;
  /** Progress text for the caller's status line ("Downloading X...", "Installing..."). */
  onStatus: (status: string) => void;
};

/**
 * Install (or update/reinstall) one storefront app. Resolves to the new
 * registry entry, or null when the user declined the permission dialog.
 * Failures throw with a user-presentable message.
 *
 * The permission dialog is shown for a first install, and for an update
 * whose manifest declares permissions the currently installed package did
 * not (or a privacy policy it did not); an update that asks for nothing new
 * goes straight through.
 */
export async function installStoreApp(
  ctx: LayerContext,
  app: EvenHubStoreApp,
  options: StoreInstallOptions,
): Promise<InstalledEvenHubApp | null> {
  options.onStatus(`Downloading ${app.name}...`);
  const [download, icon] = await Promise.all([
    evenHubApi.downloadApp(app.packageId),
    app.iconPath
      ? evenHubApi.downloadPublicAsset(app.iconPath).catch((error) => {
          options.appendLog(`evenhub store: icon unavailable for ${app.packageId}: ${cleanError(error)}`);
          return undefined;
        })
      : Promise.resolve(undefined),
  ]);
  const manifest = readEvenHubPackageManifestBytes(download.bytes);
  if (!manifest) throw new Error("The downloaded EHPK manifest could not be read.");
  const privacyPolicyUrl = download.privacyPolicyUrl || manifest.privacyPolicyUrl;
  const needsPrompt = (manifest.permissions.length > 0 || privacyPolicyUrl)
    && !alreadyGranted(app.packageId, manifest);
  if (needsPrompt) {
    options.onStatus("");
    ctx.actions.requestRender();
    const accepted = await new Promise<boolean>((resolve) => {
      ctx.stack.push(
        new EvenHubPermissionDialogLayer(
          manifest.name,
          manifest.permissions,
          privacyPolicyUrl,
          () => resolve(true),
          () => resolve(false),
        ),
      );
    });
    if (!accepted) return null;
  }

  options.onStatus("Installing...");
  ctx.actions.requestRender();
  // A running instance would keep serving the old unpacked runtime; every
  // launch re-unpacks from the stored EHPK, so closing it is enough.
  closeRunningPackage(app.packageId);
  const result = installEvenHubPackageBytes(download.bytes, { expectedPackageId: app.packageId, icon });
  options.appendLog(`evenhub store: installed ${result.packageId} ${result.version} (${download.bytes.length} bytes)`);
  return result;
}

/**
 * Whether the installed package already declares every permission the new
 * manifest asks for. (The store's privacy-policy link is not compared: the
 * download metadata carries it as a CDN path while the installed app.json
 * usually has none, so comparing would re-prompt on every update.)
 */
function alreadyGranted(packageId: string, manifest: EvenHubManifest): boolean {
  const current = readEvenHubPackageManifest(installedEvenHubPackagePath(packageId));
  if (!current) return false;
  const granted = new Set(current.permissions);
  return manifest.permissions.every((permission) => granted.has(permission));
}

export function cleanError(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
}
