/**
 * Main-thread side of the app workers: real Web Workers behind the small
 * surface WorkerAppHost uses, as the native isolates are. What native workers do
 * by calling into shared JVM or Kotlin objects, these do with messages handled
 * here, out of the app protocol's sight: frames, settings writes, atlas
 * registrations.
 */
import { applyWorkerAtlasMessage } from "../native/texture-atlas";
import { applyWorkerSetting, settingsSnapshot } from "../native/settings-store";

type FrameSink = (surfaceId: string, pixels: Uint8Array, width: number, height: number, draws: ArrayBuffer | null) => void;

const live = new Set<WebAppWorker>();
let frameSink: FrameSink = () => {};

export function setWorkerFrameSink(sink: FrameSink): void {
  frameSink = sink;
}

export function broadcastSettingToWorkers(key: string, value: string, from: unknown): void {
  for (const worker of live) if (worker !== from) worker.postMessage({ type: "__setting-changed", key, value });
}

export class WebAppWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  private readonly worker: Worker;

  constructor(name: string) {
    const base = new URL("workers/", document.baseURI);
    this.worker = new Worker(new URL("worker-loader.js", base));
    live.add(this);
    this.worker.onmessage = (event) => this.receive(event);
    this.worker.onerror = (event) => {
      console.error(`Worker ${name}: ${event.message} (${event.filename}:${event.lineno})`);
      this.onerror?.(event);
    };
    this.worker.postMessage({
      settings: settingsSnapshot(),
      assetBase: new URL("assets/", document.baseURI).href,
      bundleUrl: new URL(`${name}.js`, base).href,
    });
  }

  private receive(event: MessageEvent): void {
    const message = event.data;
    switch (message?.type) {
      case "surface-frame":
        frameSink(message.surfaceId, message.pixels, message.width, message.height, message.draws ?? null);
        return;
      case "__setting-set":
        applyWorkerSetting(message.key, message.value, this);
        return;
      case "__atlas-font":
      case "__atlas-glyphs":
      case "__atlas-firmware":
      case "__atlas-image":
        applyWorkerAtlasMessage(message);
        return;
      default:
        this.onmessage?.(event);
    }
  }

  postMessage(message: unknown): void {
    this.worker.postMessage(message);
  }

  terminate(): void {
    live.delete(this);
    this.worker.terminate();
  }
}

(globalThis as any).__faceclawNewWorker = (name: string) => new WebAppWorker(name);
