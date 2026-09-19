/**
 * Persistent registry and package storage for user-installed EvenHub apps.
 *
 * The EHPK itself is the source of truth for the runnable app. A small JSON
 * index in Faceclaw's settings store makes installed packages discoverable by
 * the launcher without expanding the static built-in AppDefinition registry.
 */
import {
  appFilesDirPath,
  deletePathRecursively,
  readBinaryFile,
  readTextFile,
  writeBinaryFile,
} from "../../native/file-access";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { loadIconImage } from "../../native/icon-image";
import { renderSvgIcon } from "../../graphics/icons";
import { type GrayImage } from "../../graphics/image";
import { openEhpk, parseManifest, utf8Decode, type EhpkIndex, type EvenHubManifest } from "./ehpk";

const STORAGE_KEY = "evenhub.installedApps.v1";
const APP_ID_PREFIX = "evenhub-installed:";

export type InstalledEvenHubApp = {
  packageId: string;
  name: string;
  version: string;
  installedAt: string;
  /** Filename beneath the installed package directory, when artwork is available. */
  iconFile?: string;
};

export type EvenHubInstallIcon = {
  bytes: Uint8Array;
  extension: string;
};

const renderedIconCache = new Map<string, GrayImage | null>();

export function installedEvenHubAppId(packageId: string): string {
  return `${APP_ID_PREFIX}${encodeURIComponent(packageId)}`;
}

export function installedEvenHubPackageId(appId: string): string | null {
  if (!appId.startsWith(APP_ID_PREFIX)) return null;
  try {
    const packageId = decodeURIComponent(appId.slice(APP_ID_PREFIX.length));
    return packageId || null;
  } catch {
    return null;
  }
}

export function getInstalledEvenHubApps(): InstalledEvenHubApp[] {
  const raw = getStringSetting(STORAGE_KEY, "");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const apps: InstalledEvenHubApp[] = [];
    const seen = new Set<string>();
    for (const value of parsed) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      const packageId = stringValue(item.packageId).trim();
      if (!packageId || seen.has(packageId)) continue;
      seen.add(packageId);
      apps.push({
        packageId,
        name: stringValue(item.name).trim() || packageId,
        version: stringValue(item.version).trim() || "0",
        installedAt: stringValue(item.installedAt),
        iconFile: safeIconFilename(stringValue(item.iconFile)),
      });
    }
    return apps.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function getInstalledEvenHubApp(packageId: string): InstalledEvenHubApp | null {
  return getInstalledEvenHubApps().find((app) => app.packageId === packageId) ?? null;
}

export function getInstalledEvenHubAppById(appId: string): InstalledEvenHubApp | null {
  const packageId = installedEvenHubPackageId(appId);
  return packageId ? getInstalledEvenHubApp(packageId) : null;
}

export function installedEvenHubPackagePath(packageId: string): string {
  return `${installedRoot(packageId)}/package.ehpk`;
}

/** Validate and copy an EHPK into Faceclaw's app-private installed store. */
export function installEvenHubPackageBytes(
  bytes: Uint8Array,
  options: { expectedPackageId?: string; icon?: EvenHubInstallIcon } = {},
): InstalledEvenHubApp {
  const { archive, manifest } = inspectEhpk(bytes);
  if (!manifest.packageId || manifest.packageId === "unknown.package") {
    throw new Error("The EHPK manifest has no package ID.");
  }
  if (options.expectedPackageId && manifest.packageId !== options.expectedPackageId) {
    throw new Error(`Downloaded package ID ${manifest.packageId} does not match ${options.expectedPackageId}.`);
  }
  const root = installedRoot(manifest.packageId);
  const path = installedEvenHubPackagePath(manifest.packageId);
  if (!writeBinaryFile(path, bytes)) {
    throw new Error(`Could not store ${manifest.name}.`);
  }
  const previous = getInstalledEvenHubApp(manifest.packageId);
  const icon = normalizeInstallIcon(options.icon) ?? findEmbeddedIcon(archive, manifest);
  let iconFile = previous?.iconFile;
  if (icon) {
    const candidate = `icon.${icon.extension}`;
    if (writeBinaryFile(`${root}/${candidate}`, icon.bytes)) {
      iconFile = candidate;
      clearStoredIcons(root, candidate);
    } else {
      console.warn(`evenhub: could not store icon for ${manifest.packageId}`);
    }
  }
  clearRenderedIconCache(manifest.packageId);
  const installed: InstalledEvenHubApp = {
    packageId: manifest.packageId,
    name: manifest.name,
    version: manifest.version,
    installedAt: new Date().toISOString(),
    iconFile: iconFile && readBinaryFile(`${root}/${iconFile}`) ? iconFile : undefined,
  };
  const apps = getInstalledEvenHubApps().filter((app) => app.packageId !== installed.packageId);
  apps.push(installed);
  saveInstalledApps(apps);
  return installed;
}

/** Validate and install an EHPK selected in Files. */
export function installEvenHubPackageFile(path: string): InstalledEvenHubApp {
  const bytes = readBinaryFile(path);
  if (!bytes) throw new Error("Could not read the EHPK file.");
  return installEvenHubPackageBytes(bytes);
}

/**
 * Read an .ehpk's manifest without installing it — used by the Files app to
 * show the permission-confirmation dialog before install/run. Returns null if
 * the file can't be read or parsed.
 */
export function readEvenHubPackageManifest(path: string): EvenHubManifest | null {
  const bytes = readBinaryFile(path);
  if (!bytes) return null;
  try {
    return inspectEhpk(bytes).manifest;
  } catch {
    return null;
  }
}

/** Inspect already-loaded package bytes before installation/first-run approval. */
export function readEvenHubPackageManifestBytes(bytes: Uint8Array): EvenHubManifest | null {
  try {
    return inspectEhpk(bytes).manifest;
  } catch {
    return null;
  }
}

/** Remove the stored EHPK, unpacked runtime files, and registry entry. */
export function uninstallEvenHubPackage(packageId: string): boolean {
  const apps = getInstalledEvenHubApps();
  if (!apps.some((app) => app.packageId === packageId)) return false;
  saveInstalledApps(apps.filter((app) => app.packageId !== packageId));
  deletePathRecursively(installedRoot(packageId));
  deletePathRecursively(`${appFilesDirPath()}/evenhub-apps/${safePackageId(packageId)}`);
  clearRenderedIconCache(packageId);
  return true;
}

/** Add or replace artwork for an existing install (used to backfill old installs). */
export function setInstalledEvenHubIcon(packageId: string, icon: EvenHubInstallIcon): boolean {
  const normalized = normalizeInstallIcon(icon);
  const apps = getInstalledEvenHubApps();
  const index = apps.findIndex((app) => app.packageId === packageId);
  if (!normalized || index < 0) return false;
  const root = installedRoot(packageId);
  const iconFile = `icon.${normalized.extension}`;
  if (!writeBinaryFile(`${root}/${iconFile}`, normalized.bytes)) return false;
  clearStoredIcons(root, iconFile);
  apps[index] = { ...apps[index]!, iconFile };
  clearRenderedIconCache(packageId);
  saveInstalledApps(apps);
  return true;
}

/** Render an installed app's SVG/raster artwork at launcher/sidebar size. */
export function renderInstalledEvenHubIcon(
  packageId: string,
  size: number,
  installedApp?: InstalledEvenHubApp,
): GrayImage | null {
  const app = installedApp ?? getInstalledEvenHubApp(packageId);
  if (!app?.iconFile) return null;
  const cacheKey = `${packageId}:${app.installedAt}:${app.iconFile}:${Math.round(size)}`;
  if (renderedIconCache.has(cacheKey)) return renderedIconCache.get(cacheKey) ?? null;
  const path = `${installedRoot(packageId)}/${app.iconFile}`;
  let image: GrayImage | null = null;
  if (app.iconFile.endsWith(".svg")) {
    const svg = readTextFile(path);
    if (svg) image = renderSvgIcon(cacheKey, svg, size);
  } else {
    image = loadIconImage(path, size, size);
  }
  renderedIconCache.set(cacheKey, image);
  return image;
}

/** Raw registry value, suitable for cheap launcher change detection. */
export function getInstalledEvenHubFingerprint(): string {
  return getStringSetting(STORAGE_KEY, "");
}

function inspectEhpk(bytes: Uint8Array): { archive: EhpkIndex; manifest: EvenHubManifest } {
  const archive = openEhpk(bytes);
  const appJson = archive.files.get("app.json");
  if (!appJson) throw new Error("The EHPK package has no app.json manifest.");
  return { archive, manifest: parseManifest(utf8Decode(appJson)) };
}

function installedRoot(packageId: string): string {
  return `${appFilesDirPath()}/evenhub-installed/${safePackageId(packageId)}`;
}

function safePackageId(packageId: string): string {
  return packageId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function saveInstalledApps(apps: InstalledEvenHubApp[]): void {
  setStringSetting(
    STORAGE_KEY,
    JSON.stringify(apps.slice().sort((a, b) => a.name.localeCompare(b.name))),
  );
}

function findEmbeddedIcon(archive: EhpkIndex, manifest: EvenHubManifest): EvenHubInstallIcon | null {
  const candidates: string[] = [];
  for (const key of ["icon", "icon_path", "iconPath", "app_icon", "appIcon"]) {
    const value = manifest.raw[key];
    if (typeof value === "string") candidates.push(value);
  }
  const entrypoint = archive.files.get(`dist/${manifest.entrypoint}`);
  if (entrypoint) {
    const html = utf8Decode(entrypoint);
    for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
      if (!/\brel\s*=\s*["'][^"']*icon/i.test(tag)) continue;
      const href = tag.match(/\bhref\s*=\s*["']([^"']+)/i)?.[1];
      if (href) candidates.push(href);
    }
  }
  candidates.push(
    "icon.svg", "icon.png", "favicon.svg", "favicon.png",
    "dist/icon.svg", "dist/icon.png", "dist/favicon.svg", "dist/favicon.png",
  );
  for (const candidate of candidates) {
    const normalized = normalizeArchivePath(candidate);
    if (!normalized) continue;
    for (const path of [normalized, `dist/${normalized}`]) {
      const content = archive.files.get(path);
      const extension = iconExtension(path);
      if (content && extension) return { bytes: content, extension };
    }
  }
  const fallback = Array.from(archive.files.keys()).find((path) =>
    /(?:^|\/)(?:app-?)?(?:icon|favicon)\.(?:svg|png|webp|jpe?g)$/i.test(path),
  );
  const extension = fallback ? iconExtension(fallback) : null;
  return fallback && extension ? { bytes: archive.files.get(fallback)!, extension } : null;
}

function normalizeInstallIcon(icon: EvenHubInstallIcon | undefined): EvenHubInstallIcon | null {
  if (!icon || icon.bytes.length === 0 || icon.bytes.length > 1_000_000) return null;
  const extension = iconExtension(`icon.${icon.extension}`);
  return extension ? { bytes: icon.bytes, extension } : null;
}

function normalizeArchivePath(path: string): string {
  const clean = path.split(/[?#]/, 1)[0]!.replace(/^\.\//, "").replace(/^\//, "");
  return !clean || clean.includes("..") || /^[a-z]+:/i.test(clean) ? "" : clean;
}

function iconExtension(path: string): string | null {
  const match = path.toLowerCase().match(/\.(svg|png|webp|jpe?g)$/);
  return match ? (match[1] === "jpeg" ? "jpg" : match[1]!) : null;
}

function safeIconFilename(value: string): string | undefined {
  return /^icon\.(?:svg|png|webp|jpg)$/i.test(value) ? value.toLowerCase() : undefined;
}

function clearStoredIcons(root: string, keep = ""): void {
  for (const extension of ["svg", "png", "webp", "jpg"]) {
    const filename = `icon.${extension}`;
    if (filename !== keep) deletePathRecursively(`${root}/${filename}`);
  }
}

function clearRenderedIconCache(packageId: string): void {
  for (const key of Array.from(renderedIconCache.keys())) {
    if (key.startsWith(`${packageId}:`)) renderedIconCache.delete(key);
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
