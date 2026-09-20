/**
 * Main-thread mirror of small state that worker apps publish (the
 * "publish-state" worker reply): the latest value per key, with change
 * notifications, so main-thread consumers that are not the app's own windows
 * (a Glanceboard widget, say) can show what a worker knows without a second
 * data connection. Values cross postMessage, so they are plain JSON.
 */
const values = new Map<string, unknown>();
const listeners = new Map<string, Set<(value: unknown) => void>>();

export function publishWorkerState(key: string, value: unknown): void {
  values.set(key, value);
  for (const listener of Array.from(listeners.get(key) ?? [])) {
    try {
      listener(value);
    } catch (error) {
      console.warn(`worker-state listener for ${key} failed`, error);
    }
  }
}

/** The latest published value for `key`, or undefined when nothing was published yet. */
export function readWorkerState<T>(key: string): T | undefined {
  return values.get(key) as T | undefined;
}

/** Subscribe to later publications of `key`; returns the unsubscribe. */
export function onWorkerStateChanged<T>(key: string, listener: (value: T) => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener as (value: unknown) => void);
  return () => {
    set!.delete(listener as (value: unknown) => void);
  };
}
