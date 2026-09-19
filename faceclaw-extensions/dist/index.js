/**
 * faceclaw-extensions — type definitions for the Faceclaw extension API.
 *
 * Faceclaw (https://github.com/…/faceclaw) is an alternative host for EvenHub
 * apps that runs them directly on the Even Realities G2 glasses instead of the
 * stock Even app. An app built against the standard `@evenrealities/even_hub_sdk`
 * runs unchanged. When it happens to be running inside Faceclaw, this package
 * lets it detect that and reach a few extra, Faceclaw-only capabilities.
 *
 * Design contract:
 *  - The only entry point is the injected global `window.getFaceclawExtensions`.
 *    It is `(() => FaceclawExtensions) | null` inside Faceclaw and `undefined`
 *    in the stock Even app (and any other host). Nothing on the standard SDK or
 *    on built-in prototypes is modified — every Faceclaw capability lives behind
 *    this one global, so it is always obvious what is an extension and standard
 *    apps keep working everywhere.
 *  - New functionality is only ever *added* here; existing members keep their
 *    behavior, so pinning a version stays backwards-compatible.
 *
 * Usage:
 * ```ts
 * import { getFaceclawExtensions } from "faceclaw-extensions";
 *
 * const fc = getFaceclawExtensions();
 * if (fc) {
 *   console.log("Running in", fc.getVersion()); // "Faceclaw/0.4.0"
 *   fc.addWindowLifecycleListener((e) => {
 *     if (e.type === "hidden") pauseExpensiveWork();
 *   });
 * }
 * ```
 */
/**
 * Return the Faceclaw extension API if the app is running inside Faceclaw, or
 * `null` otherwise (the stock Even app, a browser, etc.). Safe to call anywhere.
 */
export function getFaceclawExtensions() {
    const getter = typeof window !== "undefined" ? window.getFaceclawExtensions : null;
    return typeof getter === "function" ? getter() : null;
}
