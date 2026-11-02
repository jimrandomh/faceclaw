/**
 * The real, on-device backing for `HealthStore`: files under the app's
 * documents folder, using the same `@nativescript/core` File API that
 * `open-apps-persistence.ts` already uses for the open-window list.
 *
 * Split out from `health-store.ts` purely so that module can stay free of
 * NativeScript imports and run under plain node in `tests/`; all the logic
 * worth testing is over there.
 */

import { File, Folder, knownFolders } from "@nativescript/core";

import { HealthStore, type HealthStorageBackend } from "./health-store";

const FOLDER_NAME = "health";

function healthFolder(): Folder {
  return knownFolders.documents().getFolder(FOLDER_NAME);
}

function pathFor(name: string): string {
  return `${healthFolder().path}/${name}`;
}

class FileBackend implements HealthStorageBackend {
  exists(name: string): boolean {
    try {
      return File.exists(pathFor(name));
    } catch {
      return false;
    }
  }

  read(name: string): string | null {
    try {
      if (!File.exists(pathFor(name))) return null;
      return File.fromPath(pathFor(name)).readTextSync();
    } catch (error) {
      console.warn(`health store read failed (${name})`, error);
      return null;
    }
  }

  append(name: string, text: string): void {
    // NativeScript reports IO failures through callbacks as well as throws.
    // Propagate both so the caller retains the unconsumed ring batch.
    checkedFileOperation((onError) => File.fromPath(pathFor(name)).appendTextSync(text, onError));
  }

  write(name: string, text: string): void {
    checkedFileOperation((onError) => File.fromPath(pathFor(name)).writeTextSync(text, onError));
  }

  list(): string[] {
    try {
      return healthFolder()
        .getEntitiesSync()
        .map((entity) => entity.name);
    } catch (error) {
      console.warn("health store list failed", error);
      return [];
    }
  }
}

/** Convert a synchronous NativeScript error callback into a thrown failure. */
export function checkedFileOperation(operation: (onError: (error: any) => void) => void): void {
  let failure: Error | undefined;
  operation((error) => {
    failure = error instanceof Error ? error : new Error(error?.message ?? String(error));
  });
  if (failure) throw failure;
}

let store: HealthStore | null = null;

/** The app's one health store. Created on first use. */
export function healthStore(): HealthStore {
  if (!store) store = new HealthStore(new FileBackend());
  return store;
}
