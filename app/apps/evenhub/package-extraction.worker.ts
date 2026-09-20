import '@nativescript/core/globals';
import { extractPackage } from './package-extraction';

global.onmessage = (event: { data: { path: string; directory: string } }) => {
  try {
    const manifest = extractPackage(event.data.path, event.data.directory);
    global.postMessage({ manifest });
  } catch (error) { global.postMessage({ error: String((error as Error)?.message ?? error) }); }
};
