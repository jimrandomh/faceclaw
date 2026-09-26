/** Exported native API normalized across Java interfaces and Obj-C protocols. */
export interface KotlinBridge {
  platform(): string;
  threadName(): string;
  isMainThread(): boolean;
  greet(name: string): string;
  /** Synchronous callback; must not throw across the native boundary. */
  roundTrip(message: string, transform: (message: string) => string): string;
}

export function createKotlinBridge(): KotlinBridge;
