/** Android document-picker support for standard WebView file inputs. */
import { Application } from "@nativescript/core";

declare const android: any;

/** Distinct from Faceclaw's QR scanner and permission request codes. */
export const EVENHUB_FILE_CHOOSER_REQUEST_CODE = 0x46c1;

const EXTENSION_MIME_TYPES: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw: "application/vnd.amazon.ebook",
  azw3: "application/vnd.amazon.ebook",
  txt: "text/plain",
  html: "text/html",
  htm: "text/html",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

/**
 * How long a launched picker may hold the single pending slot before the host
 * reclaims it. Android supports only one system picker at a time, so a picker
 * that never returns a result would otherwise block file inputs in every other
 * hosted app for the rest of the process. Ten minutes is far longer than any
 * real file-browsing session and still self-heals within one app session.
 */
export const EVENHUB_FILE_CHOOSER_TIMEOUT_MS = 10 * 60 * 1000;

/** Host-side picker trace; the WebView console client already surfaces it. */
function log(message: string): void {
  try {
    console.warn(`evenhub picker: ${message}`);
  } catch {
    // A missing console must never break picking.
  }
}

type Pending = {
  owner: any;
  callback: any;
  activity: any;
  timer: any;
};

/** True when this runtime exposes timers (the host always does). */
function hasTimers(): boolean {
  return typeof setTimeout === "function" && typeof clearTimeout === "function";
}

/**
 * One picker at a time for all hosted EvenHub WebViews. Activity references
 * live only in [pending], never in the long-lived coordinator. This matches
 * Android's file-input model: destroying the activity that launched a picker
 * cancels its input rather than trying to relaunch it in a new window.
 */
export class EvenHubFileChooser {
  private pending: Pending | null = null;

  private readonly onResult = (args: { requestCode: number; resultCode: number; intent: any }): void => {
    if (args.requestCode !== EVENHUB_FILE_CHOOSER_REQUEST_CODE || !this.pending) return;
    const pending = this.pending;
    let uris: any[] | null = null;
    if (args.resultCode === android.app.Activity.RESULT_OK && args.intent) {
      try {
        uris = resultUris(args.intent);
      } catch (error) {
        console.warn(`evenhub file chooser result failed: ${error}`);
      }
    }
    this.finish(pending, uris);
  };

  private readonly onActivityDestroyed = (args: { activity: any }): void => {
    const pending = this.pending;
    // Unrelated activities (alarms, error reports) must not cancel the input.
    if (pending && args.activity === pending.activity) this.finish(pending, null);
  };

  /** Returns false when WebView should retain its default (no picker) behavior. */
  show(owner: any, callback: any, params: any): boolean {
    if (this.pending) {
      log("ignored: another picker is still pending");
      return false;
    }
    // Resolve at launch, not construction: the WebView host outlives activities.
    const activity = Application.android?.foregroundActivity ?? Application.android?.startActivity;
    if (!activity) {
      log("ignored: no foreground activity");
      return false;
    }
    log("opening document picker");
    const pending: Pending = { owner, callback, activity, timer: null };
    this.pending = pending;
    if (hasTimers()) {
      pending.timer = setTimeout(() => {
        log("timed out waiting for a document; releasing the picker slot");
        this.finish(pending, null);
      }, EVENHUB_FILE_CHOOSER_TIMEOUT_MS);
    }
    const application = Application.android;
    application.on(application.activityResultEvent, this.onResult);
    application.on(application.activityDestroyedEvent, this.onActivityDestroyed);
    try {
      activity.startActivityForResult(buildIntent(params), EVENHUB_FILE_CHOOSER_REQUEST_CODE);
    } catch (error) {
      console.warn(`evenhub file chooser launch failed: ${error}`);
      this.finish(pending, null);
    }
    return true;
  }

  /** Cancel only this WebView's input; safe during detach and renderer loss. */
  cancel(owner: any): void {
    const pending = this.pending;
    if (pending?.owner === owner) this.finish(pending, null);
  }

  private finish(pending: Pending, uris: any[] | null): void {
    if (this.pending !== pending) return;
    this.pending = null;
    if (pending.timer !== null && hasTimers()) {
      try {
        clearTimeout(pending.timer);
      } catch {
        // A dead timer is not a reason to strand the callback.
      }
    }
    pending.timer = null;
    log(uris === null ? "closed with no document" : `closed with ${uris.length} document(s)`);
    const application = Application.android;
    application.off(application.activityResultEvent, this.onResult);
    application.off(application.activityDestroyedEvent, this.onActivityDestroyed);
    try {
      if (uris === null) {
        pending.callback.onReceiveValue(null);
      } else {
        const nativeUris = Array.create("android.net.Uri", uris.length);
        uris.forEach((uri, index) => { nativeUris[index] = uri; });
        pending.callback.onReceiveValue(nativeUris);
      }
    } catch (error) {
      console.warn(`evenhub file chooser callback failed: ${error}`);
    }
  }
}

/** Translate WebView accept syntax into a Storage Access Framework filter. */
export function buildIntent(params: any): any {
  const intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);
  intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);
  // NativeScript exposes FileChooserParams.getAcceptTypes() as a Java String[]
  // proxy, not an iterable JS array. Normalize once; both iteration and logging
  // must use this copy or every file launch fails before opening DocumentsUI.
  const acceptTypes = normalizeAcceptTypes(params?.getAcceptTypes?.());
  const accepted = acceptMimeTypes(acceptTypes);
  // An extension this host cannot name (cbz, fb2, rtf, ...) cannot be filtered
  // for. Filtering the rest would hide the very files the app asked to show,
  // so relax to every openable document rather than a narrower list.
  //
  // A single extension-derived type is also a guess: Android resolves stored
  // file MIME types by extension, and EPUB in particular is usually reported as
  // application/octet-stream. Filtering to application/epub+zip then opens a
  // picker with nothing selectable. Apps that care validate the choice
  // themselves (Books rejects non-.epub names after selection), so show
  // everything and let them decide. Declared MIME types and wildcards still
  // filter, so hosts that asked for exactly a MIME keep that behavior.
  const singleExtensionOnly =
    accepted.unknown === 0 && !accepted.declared && accepted.types.length === 1;
  const relaxed = accepted.unknown > 0 || singleExtensionOnly;
  intent.setType(!relaxed && accepted.types.length === 1 ? accepted.types[0] : "*/*");
  const relaxedWhy = accepted.unknown > 0 ? "unrepresentable extension"
    : singleExtensionOnly ? "extension-only MIME guess" : "";
  log(`launch accept=[${acceptTypes.join(",")}] -> types=[${accepted.types.join(",")}]` +
    (relaxedWhy ? ` relaxed (${relaxedWhy})` : ""));
  if (!relaxed && accepted.types.length > 1) {
    const mimeTypes = Array.create("java.lang.String", accepted.types.length);
    accepted.types.forEach((mime, index) => { mimeTypes[index] = mime; });
    intent.putExtra(android.content.Intent.EXTRA_MIME_TYPES, mimeTypes);
  }
  intent.putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE,
    params?.getMode?.() === android.webkit.WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
  return intent;
}

/**
 * NativeScript's Java String[] proxy has indexed elements and `length`, but no
 * JavaScript iterator. Convert by index rather than `for…of`, `join`, or
 * spreading it. WebView calls with no accept filter return null/empty.
 */
function normalizeAcceptTypes(values: unknown): string[] {
  if (values === null || values === undefined) return [];
  const array = values as { length?: unknown } & Record<number, unknown>;
  const length = Number(array.length ?? 0);
  if (!Number.isSafeInteger(length) || length < 0) return [];
  const result: string[] = [];
  for (let index = 0; index < length; index++) result.push(String(array[index] ?? ""));
  return result;
}

function acceptMimeTypes(values: string[]): { types: string[]; unknown: number; declared: boolean } {
  const types: string[] = [];
  let unknown = 0;
  let declared = false;
  for (const raw of values) {
    for (const item of String(raw).split(",")) {
      const accept = item.trim().toLowerCase();
      if (!accept) continue;
      const fromExtension = accept.startsWith(".");
      if (!fromExtension) declared = true;
      const mime = fromExtension
        ? EXTENSION_MIME_TYPES[accept.slice(1)]
        : accept;
      // An extension this table cannot name is counted, not silently dropped:
      // the caller relaxes the filter instead of hiding the files asked for.
      if (!mime) unknown += 1;
      else if (!types.includes(mime)) types.push(mime);
    }
  }
  return { types, unknown, declared };
}

/** Android returns ClipData for multi-select and getData for a single document. */
function resultUris(intent: any): any[] {
  const clip = intent.getClipData();
  if (clip) {
    const uris = [];
    for (let index = 0; index < clip.getItemCount(); index++) {
      const uri = clip.getItemAt(index)?.getUri();
      if (uri) uris.push(uri);
    }
    return uris;
  }
  const uri = intent.getData();
  return uri ? [uri] : [];
}
