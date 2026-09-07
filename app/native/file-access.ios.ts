import { knownFolders, path as paths } from '@nativescript/core'
export type DirectoryEntry = { name: string; path: string; isDirectory: boolean; sizeBytes: number; modifiedMs: number }
const fm = NSFileManager.defaultManager
// The iOS Files app exposes Documents; access is limited to Faceclaw's container.
export function hasAllFilesAccess(): boolean { return true }
export function requestAllFilesAccess(): void {}
export function externalStorageRootPath(): string { return knownFolders.documents().path }
export function appFilesDirPath(): string { return knownFolders.documents().path }
export function statPath(path: string): DirectoryEntry | null {
  try {
    const attrs = fm.attributesOfItemAtPathError(path)
    if (!attrs) return null
    const modified: any = attrs.objectForKey(NSFileModificationDate)
    return { name: path.slice(path.lastIndexOf('/') + 1), path, isDirectory: attrs.objectForKey(NSFileType) === NSFileTypeDirectory,
      sizeBytes: Number(attrs.objectForKey(NSFileSize)) || 0,
      modifiedMs: modified instanceof Date ? modified.getTime() : Number(modified?.timeIntervalSince1970 ?? 0) * 1000 }
  } catch { return null }
}
export function listDirectory(path: string): DirectoryEntry[] | null {
  try {
    const names = fm.contentsOfDirectoryAtPathError(path), entries: DirectoryEntry[] = []
    for (let i = 0; i < names.count; i++) { const entry = statPath(paths.join(path, names.objectAtIndex(i))); if (entry) entries.push(entry) }
    return entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
  } catch { return null }
}
export function readBinaryFile(path: string): Uint8Array | null {
  const data = NSData.dataWithContentsOfFile(path)
  return data ? new Uint8Array(interop.bufferFromData(data)).slice() : null
}
export function writeBinaryFile(path: string, bytes: Uint8Array): boolean {
  try {
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path.slice(0, path.lastIndexOf('/')), true, null)
    const copy = bytes.slice(), data = NSData.dataWithBytesLength(interop.handleof(copy.buffer), copy.byteLength)
    return data.writeToFileAtomically(path, true)
  } catch { return false }
}
export function readTextFile(path: string): string | null {
  const entry = statPath(path)
  if (!entry || entry.isDirectory || entry.sizeBytes > 2_000_000) return null
  const data = NSData.dataWithContentsOfFile(path)
  const text = data ? NSString.alloc().initWithDataEncoding(data, NSUTF8StringEncoding) : null
  return text == null ? null : String(text).slice(0, 500_000)
}
export function writeTextToDownloads(filename: string, text: string): string | null {
  const path = paths.join(knownFolders.documents().path, 'Downloads', filename.slice(filename.lastIndexOf('/') + 1))
  const data = NSString.stringWithString(text).dataUsingEncoding(NSUTF8StringEncoding)
  return writeBinaryFile(path, new Uint8Array(interop.bufferFromData(data))) ? path : null
}
export function deletePathRecursively(path: string): void {
  try { if (fm.fileExistsAtPath(path)) fm.removeItemAtPathError(path) } catch (error) { console.warn(`Delete failed: ${error}`) }
}
