/**
 * The subset of @nativescript/core the shared app code uses, for the browser
 * demo (aliased in scripts/build-web.mjs). Android-only members stay absent or
 * null: the code calling them is guarded by global.isAndroid, which the web
 * build defines as false.
 */
import {
  APP_ROOT, DOCUMENTS_ROOT, appendFile, bytesToText, directoryExists, ensureDirectory, fileExists, fileInfo,
  listDirectory, normalizePath, readFile, removePath, textToBytes, writeFile,
} from "./vfs";
import { alertDialog, actionDialog, confirmDialog, promptDialog } from "./dialogs";

export const isAndroid = false;
export const isIOS = false;

export const Utils = {
  android: { getApplicationContext: (): null => null },
  isMainThread: (): boolean => typeof document !== "undefined",
  dispatchToMainThread: (callback: () => void): void => { queueMicrotask(callback); },
  queueMacrotask: (callback: () => void): void => { setTimeout(callback, 0); },
  executeOnMainThread: (callback: () => void): void => { callback(); },
  mainThreadify: <T extends (...args: any[]) => any>(callback: T): T => callback,
  openUrl: (url: string): boolean => {
    if (typeof window === "undefined") return false;
    window.open(url, "_blank", "noopener");
    return true;
  },
  GC: (): void => {},
};

type OnError = (error: unknown) => void;

function guarded<T>(onError: OnError | undefined, action: () => T, fallback: T): T {
  try {
    return action();
  } catch (error) {
    if (onError) { onError(error); return fallback; }
    throw error;
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error(`Unsupported file data: ${String(data)}`);
}

export class FileSystemEntity {
  constructor(readonly path: string) {}
  get name(): string { return this.path.slice(this.path.lastIndexOf("/") + 1); }
  get parent(): Folder { return new Folder(this.path.slice(0, this.path.lastIndexOf("/")) || "/"); }
  get lastModified(): Date { return new Date(fileInfo(this.path)?.modifiedMs ?? 0); }
  removeSync(onError?: OnError): void { guarded(onError, () => removePath(this.path), undefined); }
  remove(): Promise<void> { removePath(this.path); return Promise.resolve(); }
}

export class File extends FileSystemEntity {
  static fromPath(path: string): File { return new File(normalizePath(path)); }
  static exists(path: string): boolean { return fileExists(path); }
  get extension(): string { const dot = this.name.lastIndexOf("."); return dot < 0 ? "" : this.name.slice(dot); }
  get size(): number { return fileInfo(this.path)?.sizeBytes ?? 0; }
  readSync(onError?: OnError): Uint8Array {
    return guarded(onError, () => {
      const bytes = readFile(this.path);
      if (!bytes) throw new Error(`No such file: ${this.path}`);
      return bytes;
    }, new Uint8Array());
  }
  read(): Promise<Uint8Array> { return Promise.resolve().then(() => this.readSync()); }
  readText(): Promise<string> { return Promise.resolve().then(() => this.readTextSync()); }
  readTextSync(onError?: OnError): string {
    return guarded(onError, () => bytesToText(this.readSync()), "");
  }
  writeSync(data: unknown, onError?: OnError): void {
    guarded(onError, () => writeFile(this.path, toBytes(data).slice()), undefined);
  }
  write(data: unknown): Promise<void> { return Promise.resolve().then(() => this.writeSync(data)); }
  writeText(text: string): Promise<void> { return Promise.resolve().then(() => this.writeTextSync(text)); }
  writeTextSync(text: string, onError?: OnError): void {
    guarded(onError, () => writeFile(this.path, textToBytes(text)), undefined);
  }
  appendTextSync(text: string, onError?: OnError): void {
    guarded(onError, () => appendFile(this.path, textToBytes(text)), undefined);
  }
}

export class Folder extends FileSystemEntity {
  static fromPath(path: string): Folder {
    const folder = new Folder(normalizePath(path));
    ensureDirectory(folder.path);
    return folder;
  }
  static exists(path: string): boolean { return directoryExists(path); }
  contains(name: string): boolean { return fileExists(`${this.path}/${name}`) || directoryExists(`${this.path}/${name}`); }
  getFile(name: string): File { return File.fromPath(`${this.path}/${name}`); }
  getFolder(name: string): Folder { return Folder.fromPath(`${this.path}/${name}`); }
  getEntitiesSync(onError?: OnError): FileSystemEntity[] {
    return guarded(onError, () => listDirectory(this.path).map((child) =>
      child.isDirectory ? new Folder(child.path) : new File(child.path)), []);
  }
  getEntities(): Promise<FileSystemEntity[]> { return Promise.resolve(this.getEntitiesSync()); }
  clearSync(onError?: OnError): void {
    guarded(onError, () => { for (const child of listDirectory(this.path)) removePath(child.path); }, undefined);
  }
}

export const knownFolders = {
  documents: (): Folder => Folder.fromPath(DOCUMENTS_ROOT),
  temp: (): Folder => Folder.fromPath(`${DOCUMENTS_ROOT}/.tmp`),
  currentApp: (): Folder => new Folder(APP_ROOT),
  externalDocuments: (): Folder => Folder.fromPath(DOCUMENTS_ROOT),
  ios: { library: (): Folder => Folder.fromPath(`${DOCUMENTS_ROOT}/.library`) },
};

export const path = {
  separator: "/",
  join: (...parts: string[]): string => normalizePath(parts.join("/")),
  normalize: (value: string): string => normalizePath(value),
};

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

const APPLICATION_SETTINGS_PREFIX = "faceclaw.app.";
const workerApplicationSettings = new Map<string, string>();

function readStored(key: string): string | null {
  const local = storage();
  if (local) return local.getItem(APPLICATION_SETTINGS_PREFIX + key);
  return workerApplicationSettings.get(key) ?? null;
}

function writeStored(key: string, value: string | null): void {
  const local = storage();
  if (local) {
    if (value === null) local.removeItem(APPLICATION_SETTINGS_PREFIX + key);
    else local.setItem(APPLICATION_SETTINGS_PREFIX + key, value);
  } else if (value === null) workerApplicationSettings.delete(key);
  else workerApplicationSettings.set(key, value);
}

export const ApplicationSettings = {
  hasKey: (key: string): boolean => readStored(key) !== null,
  remove: (key: string): void => writeStored(key, null),
  clear: (): void => {
    const local = storage();
    if (!local) { workerApplicationSettings.clear(); return; }
    for (let i = local.length - 1; i >= 0; i--) {
      const key = local.key(i);
      if (key?.startsWith(APPLICATION_SETTINGS_PREFIX)) local.removeItem(key);
    }
  },
  getString: (key: string, fallback?: string): any => readStored(key) ?? fallback,
  setString: (key: string, value: string): void => writeStored(key, String(value)),
  getBoolean: (key: string, fallback?: boolean): any => {
    const raw = readStored(key);
    return raw === null ? fallback : raw === "true";
  },
  setBoolean: (key: string, value: boolean): void => writeStored(key, String(Boolean(value))),
  getNumber: (key: string, fallback?: number): any => {
    const raw = readStored(key);
    return raw === null ? fallback : Number(raw);
  },
  setNumber: (key: string, value: number): void => writeStored(key, String(value)),
  getAllKeys: (): string[] => {
    const local = storage();
    if (!local) return [...workerApplicationSettings.keys()];
    const keys: string[] = [];
    for (let i = 0; i < local.length; i++) {
      const key = local.key(i);
      if (key?.startsWith(APPLICATION_SETTINGS_PREFIX)) keys.push(key.slice(APPLICATION_SETTINGS_PREFIX.length));
    }
    return keys;
  },
};

/** The page is always "running": lifecycle subscriptions have nothing to wait for. */
export const Application = {
  launchEvent: "launch",
  resumeEvent: "resume",
  suspendEvent: "suspend",
  exitEvent: "exit",
  discardedMemoryEvent: "discardedMemory",
  suspended: false,
  android: null as any,
  on: (_event: string, _listener: (...args: any[]) => void): void => {},
  off: (_event: string, _listener?: (...args: any[]) => void): void => {},
};

export const Dialogs = {
  alert: (options: string | { title?: string; message?: string; okButtonText?: string }) =>
    alertDialog(typeof options === "string" ? { message: options } : options),
  confirm: (options: string | { title?: string; message?: string; okButtonText?: string; cancelButtonText?: string }) =>
    confirmDialog(typeof options === "string" ? { message: options } : options),
  prompt: promptDialog,
  action: actionDialog,
};

/** Only ever a placeholder here: the page draws pixels straight to a canvas. */
export class ImageSource {
  constructor(readonly native: unknown = null) {}
}

export { request } from "./nativescript-http";
export const Http = { request: (options: Parameters<typeof import("./nativescript-http").request>[0]) => import("./nativescript-http").then((http) => http.request(options)) };
