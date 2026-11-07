/** Files app storage: the demo's virtual documents folder, which the page seeds with sample files. */
import { bytesToText, DOCUMENTS_ROOT, fileInfo, directoryExists, listDirectory as listVirtualDirectory, readFile, removePath, textToBytes, writeFile } from "../web/vfs";

export type DirectoryEntry = { name: string; path: string; isDirectory: boolean; sizeBytes: number; modifiedMs: number };

export function hasAllFilesAccess(): boolean { return true; }
export function requestAllFilesAccess(): void {}
export function externalStorageRootPath(): string { return DOCUMENTS_ROOT; }
export function appFilesDirPath(): string { return DOCUMENTS_ROOT; }
export function appCacheDirPath(): string { return `${DOCUMENTS_ROOT}/.tmp`; }

export function statPath(path: string): DirectoryEntry | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (directoryExists(path)) return { name, path, isDirectory: true, sizeBytes: 0, modifiedMs: 0 };
  const info = fileInfo(path);
  return info ? { name, path, isDirectory: false, ...info } : null;
}

export function listDirectory(path: string): DirectoryEntry[] | null {
  if (!directoryExists(path)) return null;
  // Internals the demo keeps there (fonts, health data, ...) aren't the visitor's files.
  const hidden = path === DOCUMENTS_ROOT ? new Set(["fonts", "health", ".tmp", ".library", "analytics"]) : new Set<string>();
  return listVirtualDirectory(path)
    .filter((child) => !hidden.has(child.name) && !child.name.endsWith(".json"))
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}

export function readBinaryFile(path: string): Uint8Array | null { return readFile(path); }

export function writeBinaryFile(path: string, bytes: Uint8Array): boolean {
  try { writeFile(path, bytes.slice()); return true; } catch { return false; }
}

export function readTextFile(path: string): string | null {
  const bytes = readFile(path);
  return bytes ? bytesToText(bytes).slice(0, 500_000) : null;
}

export function writeTextToDownloads(filename: string, text: string): string | null {
  const path = `${DOCUMENTS_ROOT}/Downloads/${filename.slice(filename.lastIndexOf("/") + 1)}`;
  try { writeFile(path, textToBytes(text)); return path; } catch { return null; }
}

export function deletePathRecursively(path: string): void { removePath(path); }
