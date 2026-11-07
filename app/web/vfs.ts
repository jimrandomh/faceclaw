/**
 * The browser demo's filesystem, behind the NativeScript File/Folder shim
 * (nativescript-core.ts) and Kotlin's readFileData.
 *
 *   /app/...        Bundled, read-only assets (fonts, images, docs), fetched from
 *                   assets/ next to the page. Reads are synchronous because the
 *                   app's font loaders run at module-evaluation time: the main
 *                   thread preloads what it needs first (preloadAssets) and both
 *                   sides fall back to a synchronous XHR.
 *   /documents/...  Writable files. In memory, and on the main thread also saved
 *                   to IndexedDB. Workers get their own empty copy: no worker app
 *                   keeps documents, they only read fonts.
 *   /documents/fonts/ also shows the bundled TTFs, so "preinstalling" them copies
 *                   nothing and workers find the fonts settings point at.
 */
declare const __FACECLAW_ASSETS__: readonly string[];

export const APP_ROOT = "/app";
export const DOCUMENTS_ROOT = "/documents";
const FONTS_DIR = `${DOCUMENTS_ROOT}/fonts`;
const BUNDLED_FONTS_DIR = `${APP_ROOT}/fonts/ttf`;

type Stored = { bytes: Uint8Array; modifiedMs: number };

const isWindow = typeof document !== "undefined";
const assetBytes = new Map<string, Uint8Array>();
const assets = new Set(__FACECLAW_ASSETS__.map((rel) => `${APP_ROOT}/${rel}`));
const documents = new Map<string, Stored>();
const documentDirs = new Set<string>([DOCUMENTS_ROOT, FONTS_DIR]);

function assetBaseUrl(): string {
  const boot = (globalThis as any).__faceclawBoot;
  if (boot?.assetBase) return boot.assetBase;
  return new URL("assets/", isWindow ? document.baseURI : location.href).href;
}

function assetUrl(path: string): string {
  return assetBaseUrl() + path.slice(APP_ROOT.length + 1).split("/").map(encodeURIComponent).join("/");
}

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** A bundled font's real path, for the overlay on the installed-fonts folder. */
function resolveOverlay(path: string): string {
  if (path.startsWith(`${FONTS_DIR}/`) && !documents.has(path)) {
    const bundled = `${BUNDLED_FONTS_DIR}/${path.slice(FONTS_DIR.length + 1)}`;
    if (assets.has(bundled)) return bundled;
  }
  return path;
}

function fetchAssetSync(path: string): Uint8Array | null {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", assetUrl(path), false);
  // A window's synchronous XHR can't set responseType; a worker's can.
  if (isWindow) xhr.overrideMimeType("text/plain; charset=x-user-defined");
  else xhr.responseType = "arraybuffer";
  xhr.send();
  if (xhr.status !== 200 && xhr.status !== 0) return null;
  if (!isWindow) return xhr.response ? new Uint8Array(xhr.response as ArrayBuffer) : null;
  const text = xhr.responseText;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/** Fetch bundled files ahead of the synchronous reads that will want them. */
export async function preloadAssets(relativePaths: readonly string[]): Promise<void> {
  await Promise.all(relativePaths.map(async (rel) => {
    const path = `${APP_ROOT}/${rel}`;
    if (!assets.has(path) || assetBytes.has(path)) return;
    try {
      const response = await fetch(assetUrl(path));
      if (response.ok) assetBytes.set(path, new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      console.warn(`preload failed for ${rel}: ${error}`);
    }
  }));
}

export function readFile(rawPath: string): Uint8Array | null {
  const path = resolveOverlay(normalizePath(rawPath));
  const stored = documents.get(path);
  if (stored) return stored.bytes;
  if (!assets.has(path)) return null;
  let bytes = assetBytes.get(path) ?? null;
  if (!bytes) {
    bytes = fetchAssetSync(path);
    if (bytes) assetBytes.set(path, bytes);
  }
  return bytes;
}

export function writeFile(rawPath: string, bytes: Uint8Array): void {
  const path = normalizePath(rawPath);
  if (!path.startsWith(`${DOCUMENTS_ROOT}/`)) throw new Error(`Read-only path: ${path}`);
  ensureDirectory(path.slice(0, path.lastIndexOf("/")));
  documents.set(path, { bytes, modifiedMs: Date.now() });
  schedulePersist(path);
}

export function appendFile(rawPath: string, bytes: Uint8Array): void {
  const existing = readFile(rawPath);
  if (!existing) { writeFile(rawPath, bytes); return; }
  const joined = new Uint8Array(existing.length + bytes.length);
  joined.set(existing);
  joined.set(bytes, existing.length);
  writeFile(rawPath, joined);
}

export function ensureDirectory(rawPath: string): void {
  const path = normalizePath(rawPath);
  if (!path.startsWith(DOCUMENTS_ROOT)) return;
  let current = "";
  for (const part of path.slice(1).split("/")) {
    current += `/${part}`;
    documentDirs.add(current);
  }
}

export function fileExists(rawPath: string): boolean {
  const path = resolveOverlay(normalizePath(rawPath));
  return documents.has(path) || assets.has(path);
}

export function directoryExists(rawPath: string): boolean {
  const path = normalizePath(rawPath);
  if (documentDirs.has(path) || path === APP_ROOT) return true;
  const prefix = `${path}/`;
  for (const asset of assets) if (asset.startsWith(prefix)) return true;
  return false;
}

export type DirectoryChild = { name: string; path: string; isDirectory: boolean; sizeBytes: number; modifiedMs: number };

export function listDirectory(rawPath: string): DirectoryChild[] {
  const path = normalizePath(rawPath);
  const prefix = path === "/" ? "/" : `${path}/`;
  const children = new Map<string, DirectoryChild>();
  const add = (childPath: string, stored: Stored | null): void => {
    if (!childPath.startsWith(prefix)) return;
    const rest = childPath.slice(prefix.length);
    if (!rest) return;
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    if (slash >= 0) {
      if (!children.has(name)) children.set(name, { name, path: prefix + name, isDirectory: true, sizeBytes: 0, modifiedMs: 0 });
      return;
    }
    children.set(name, { name, path: prefix + name, isDirectory: false, sizeBytes: stored?.bytes.length ?? 0, modifiedMs: stored?.modifiedMs ?? 0 });
  };
  for (const [childPath, stored] of documents) add(childPath, stored);
  for (const dir of documentDirs) {
    if (dir.startsWith(prefix) && dir.length > prefix.length && !dir.slice(prefix.length).includes("/")) {
      const name = dir.slice(prefix.length);
      children.set(name, { name, path: dir, isDirectory: true, sizeBytes: 0, modifiedMs: 0 });
    }
  }
  if (path.startsWith(APP_ROOT)) for (const asset of assets) add(asset, null);
  if (path === FONTS_DIR) {
    for (const asset of assets) {
      if (asset.startsWith(`${BUNDLED_FONTS_DIR}/`)) add(`${FONTS_DIR}/${asset.slice(BUNDLED_FONTS_DIR.length + 1)}`, null);
    }
  }
  return [...children.values()];
}

export function removePath(rawPath: string): void {
  const path = normalizePath(rawPath);
  const prefix = `${path}/`;
  for (const key of [...documents.keys()]) {
    if (key === path || key.startsWith(prefix)) { documents.delete(key); schedulePersist(key); }
  }
  for (const dir of [...documentDirs]) if (dir === path || dir.startsWith(prefix)) documentDirs.delete(dir);
}

export function fileInfo(rawPath: string): { sizeBytes: number; modifiedMs: number } | null {
  const path = resolveOverlay(normalizePath(rawPath));
  const stored = documents.get(path);
  if (stored) return { sizeBytes: stored.bytes.length, modifiedMs: stored.modifiedMs };
  return assets.has(path) ? { sizeBytes: readFile(path)?.length ?? 0, modifiedMs: 0 } : null;
}

export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// --- Persistence: main thread only, best effort (private windows may refuse). ---

const DATABASE = "faceclaw-demo";
const STORE = "documents";
let database: IDBDatabase | null = null;
const dirty = new Set<string>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(path: string): void {
  if (!database) return;
  dirty.add(path);
  if (persistTimer === null) persistTimer = setTimeout(flushPersist, 500);
}

function flushPersist(): void {
  persistTimer = null;
  if (!database) return;
  try {
    const store = database.transaction(STORE, "readwrite").objectStore(STORE);
    for (const path of dirty) {
      const stored = documents.get(path);
      if (stored) store.put(stored, path);
      else store.delete(path);
    }
  } catch (error) {
    console.warn(`Could not save documents: ${error}`);
  }
  dirty.clear();
}

/** Load saved documents, then keep saving changes. Never rejects. */
export function openPersistentDocuments(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = () => { console.warn(`Saved documents unavailable: ${request.error}`); resolve(); };
      request.onsuccess = () => {
        const db = request.result;
        const cursor = db.transaction(STORE).objectStore(STORE).openCursor();
        cursor.onerror = () => { database = db; resolve(); };
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) { database = db; resolve(); return; }
          const path = String(entry.key);
          documents.set(path, entry.value as Stored);
          ensureDirectory(path.slice(0, path.lastIndexOf("/")));
          entry.continue();
        };
      };
    } catch (error) {
      console.warn(`Saved documents unavailable: ${error}`);
      resolve();
    }
  });
}

/** Forget every saved document (the page's "Reset demo"). */
export function clearPersistentDocuments(): Promise<void> {
  documents.clear();
  dirty.clear();
  return new Promise((resolve) => {
    if (!database) { resolve(); return; }
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    transaction.oncomplete = transaction.onerror = () => resolve();
  });
}

// Kotlin's readFileData (PlatformServices.js.kt). A signed view shares the bytes.
(globalThis as any).faceclawReadFileSync = (path: string): Int8Array | null => {
  const bytes = readFile(path);
  return bytes ? new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
};
