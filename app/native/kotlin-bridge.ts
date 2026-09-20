import { isAndroid } from "@nativescript/core";
import { createKotlinBridge } from "./kotlin-platform";

/** Exercise the real native metadata and both directions of return values. */
export function runKotlinBridgeSmokeTest(): void {
  try {
    const bridge = createKotlinBridge();
    const platform = bridge.platform();
    const thread = bridge.threadName();
    const callerOnMain = bridge.isMainThread();
    const greeting = bridge.greet("Faceclaw");
    const message = "Faceclaw \u2194 Kotlin \ud83d\udc53";
    let callbackCount = 0;
    let callbackMessage = "";
    let callbackOnMain = false;
    // Validate after returning; never throw from a native callback.
    const reply = bridge.roundTrip(message, (value: string): string => {
      callbackCount++;
      callbackMessage = value;
      callbackOnMain = bridge.isMainThread();
      return `TypeScript received: ${value}`;
    });
    if (greeting !== "Hello, Faceclaw, from Kotlin"
      || platform !== (isAndroid ? "Android" : "iOS")
      || !thread || !callerOnMain || !callbackOnMain
      || callbackCount !== 1
      || callbackMessage !== `Kotlin received: ${message}`
      || reply !== `Kotlin received callback: TypeScript received: Kotlin received: ${message}`) {
      throw new Error(`Unexpected Kotlin bridge result: ${JSON.stringify({
        platform, thread, callerOnMain, callbackOnMain, greeting, callbackCount, callbackMessage, reply,
      })}`);
    }
    console.log("FACECLAW_KOTLIN_BRIDGE_PASS " + JSON.stringify({ platform, thread, reply }));
  } catch (error) {
    // Diagnostics must not prevent the rest of the app from launching.
    console.error("FACECLAW_KOTLIN_BRIDGE_FAIL " + error);
  }
}
