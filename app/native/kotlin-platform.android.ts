import type { KotlinBridge } from './kotlin-platform';

// Handwritten declarations for the small native surface, checked against the
// compiled API. NativeScript runtime metadata is generated from the AAR.
declare namespace com.faceclaw.shared {
  class KotlinBridge extends java.lang.Object {
    constructor();
    platform(): string;
    threadName(): string;
    isMainThread(): boolean;
    greet(name: string): string;
    roundTrip(message: string, listener: KotlinBridgeListener): string;
  }
  class KotlinBridgeListener extends java.lang.Object {
    constructor(implementation: { transform(message: string): string });
  }
}

export function createKotlinBridge(): KotlinBridge {
  const bridge = new com.faceclaw.shared.KotlinBridge();
  return {
    platform: () => bridge.platform(),
    threadName: () => bridge.threadName(),
    isMainThread: () => bridge.isMainThread(),
    greet: name => bridge.greet(name),
    roundTrip(message, transform) {
      const listener = new com.faceclaw.shared.KotlinBridgeListener({ transform });
      return bridge.roundTrip(message, listener);
    },
  };
}
