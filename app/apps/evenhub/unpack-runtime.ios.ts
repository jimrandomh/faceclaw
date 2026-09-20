import type { EvenHubManifest } from './ehpk';

/** Paths and a small manifest cross isolates; package bytes never become JSON. */
export function unpackRuntime(path: string, directory: string): Promise<EvenHubManifest> {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./package-extraction.worker');
    let settled = false;
    const finish = (error?: string, manifest?: EvenHubManifest) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); worker.terminate();
      if (error) reject(new Error(error));
      else if (manifest) resolve(manifest);
      else reject(new Error('The package worker returned no manifest.'));
    };
    const timeout = setTimeout(() => finish('Unpacking the EvenHub app timed out.'), 180_000);
    worker.onmessage = (event: MessageEvent) => finish(event.data.error, event.data.manifest);
    worker.onerror = event => { finish(String(event.message ?? event)); return true; };
    try { worker.postMessage({ path, directory }); }
    catch (error) { finish(String(error)); }
  });
}
