/**
 * Open a URL in the phone's browser. Uses the application context with
 * NEW_TASK so it works from worker threads (no Activity in hand). Returns
 * false when no browser is available or on a non-Android platform.
 */
import { Utils } from "@nativescript/core";

declare const android: any;
declare const global: any;

export function openUrlOnPhone(url: string): boolean {
  if (!global.isAndroid) return false;
  try {
    const context = Utils.android.getApplicationContext();
    if (!context) return false;
    const intent = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
    intent.addCategory(android.content.Intent.CATEGORY_BROWSABLE);
    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
    context.startActivity(intent);
    return true;
  } catch (error) {
    console.warn(`open-url: could not open ${url}: ${error}`);
    return false;
  }
}
