import { runKotlinProtocolSmokeTest } from './kotlin-protocol-smoke';
import { isAndroid } from "@nativescript/core";

// Handwritten declarations for this small native surface. NativeScript builds
// the runtime metadata from Kotlin's compiled classes, not these declarations.
declare namespace com.faceclaw.shared {
  class KotlinBridge extends java.lang.Object {
    constructor();
    greet(name: string): string;
    roundTrip(message: string, listener: KotlinBridgeListener): string;
  }
  class KotlinBridgeListener extends java.lang.Object {
    constructor(implementation: { transform(message: string): string });
  }
}

/** Exercise the real native metadata and both directions of return values. */
export function runKotlinBridgeSmokeTest(): void {
  if (!isAndroid) return;

  try {
    runKotlinProtocolSmokeTest();
    const bridge = new com.faceclaw.shared.KotlinBridge();
    const greeting = bridge.greet("Faceclaw");
    const message = "Faceclaw \u2194 Kotlin \ud83d\udc53";
    let callbackCount = 0;
    let callbackMessage = "";
    // Keep the proxy in scope through the synchronous native call. Do not
    // throw from the callback; validate after returning across the boundary.
    const listener = new com.faceclaw.shared.KotlinBridgeListener({
      transform(value: string): string {
        callbackCount++;
        callbackMessage = value;
        return `TypeScript received: ${value}`;
      },
    });
    const reply = bridge.roundTrip(message, listener);
    if (greeting !== "Hello, Faceclaw, from Kotlin"
      || callbackCount !== 1
      || callbackMessage !== `Kotlin received: ${message}`
      || reply !== `Kotlin received callback: TypeScript received: Kotlin received: ${message}`) {
      throw new Error(`Unexpected Kotlin bridge result: ${JSON.stringify({
        greeting, callbackCount, callbackMessage, reply,
      })}`);
    }
    console.log("FACECLAW_KOTLIN_BRIDGE_PASS " + reply);
  } catch (error) {
    // Diagnostics must not prevent the rest of the app from launching.
    console.error("FACECLAW_KOTLIN_BRIDGE_FAIL " + error);
  }
}
