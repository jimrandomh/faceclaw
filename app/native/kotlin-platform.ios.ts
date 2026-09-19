import type { KotlinBridge } from './kotlin-platform';

// Handwritten declarations matching FaceclawKit's Objective-C header.
declare class FaceclawKitKotlinBridge extends NSObject {
  static alloc(): FaceclawKitKotlinBridge;
  init(): this;
  platform(): string;
  threadName(): string;
  isMainThread(): boolean;
  greetName(name: string): string;
  roundTripMessageListener(message: string, listener: FaceclawKitKotlinBridgeListener): string;
}
interface FaceclawKitKotlinBridgeListener {
  transformMessage(message: string): string;
}
declare const FaceclawKitKotlinBridgeListener: {
  prototype: FaceclawKitKotlinBridgeListener;
};

@NativeClass()
class KotlinCallback extends NSObject implements FaceclawKitKotlinBridgeListener {
  static ObjCProtocols = [FaceclawKitKotlinBridgeListener];
  transform!: (message: string) => string;

  transformMessage(message: string): string { return this.transform(message); }
}

export function createKotlinBridge(): KotlinBridge {
  const bridge = FaceclawKitKotlinBridge.alloc().init();
  return {
    platform: () => bridge.platform(),
    threadName: () => bridge.threadName(),
    isMainThread: () => bridge.isMainThread(),
    greet: name => bridge.greetName(name),
    roundTrip(message, transform) {
      const listener = KotlinCallback.new() as KotlinCallback;
      listener.transform = transform;
      // Kotlin uses this listener synchronously and never retains it.
      return bridge.roundTripMessageListener(message, listener);
    },
  };
}
