import { Application, Utils } from "@nativescript/core";

declare const android: any;
declare const com: any;
declare const global: any;

/**
 * QR scanning for the Developer app's "Load app from QR code".
 *
 * Primary path is Play Services' ML Kit code scanner
 * (FaceclawQrScanner): the scanner UI and the camera live inside Play
 * Services, so Faceclaw declares no camera permission and needs no other app
 * installed. That last part is why it is the primary path — the ZXing "SCAN"
 * intent, which is the usual delegate-to-a-scanner-app trick, resolves to
 * nothing on a stock phone because no preinstalled app registers for it.
 *
 * The intent is kept as a fallback for a phone without Play Services, where
 * the user has presumably installed a scanner app of their own.
 */

const SCAN_ACTION = "com.google.zxing.client.android.SCAN";
// Arbitrary, only has to be distinct from other startActivityForResult callers.
const SCAN_REQUEST_CODE = 0x51d0;

// Android's scanner is owned by Play Services or another app. The load layer
// ignores its late result if the user leaves; iOS also closes its own camera.
export function cancelQrScan(): void {}

function currentActivity(): any {
  return Application.android?.foregroundActivity ?? Application.android?.startActivity ?? null;
}

function buildScanIntent(): any {
  const intent = new android.content.Intent(SCAN_ACTION);
  intent.putExtra("SCAN_MODE", "QR_CODE_MODE");
  // Ask the scanner not to keep its own history of what we scanned.
  intent.putExtra("SAVE_HISTORY", false);
  return intent;
}

/** Whether the Play Services scanner is usable on this phone. */
function isMlKitScannerAvailable(): boolean {
  const context = Utils.android.getApplicationContext();
  if (!context) return false;
  try {
    return com.faceclaw.app.FaceclawQrScanner.isAvailable(context) === true;
  } catch (error) {
    console.warn(`qr: ML Kit availability check failed: ${error}`);
    return false;
  }
}

/** Whether any installed app answers the ZXing scan intent. */
function isScanIntentAvailable(): boolean {
  const activity = currentActivity();
  if (!activity) return false;
  try {
    return buildScanIntent().resolveActivity(activity.getPackageManager()) !== null;
  } catch {
    return false;
  }
}

/** Whether scanning can be attempted at all, by either route. */
export function isQrScannerAvailable(): boolean {
  if (!global.isAndroid) return false;
  return isMlKitScannerAvailable() || isScanIntentAvailable();
}

/**
 * Open a scanner and resolve with the decoded text, or null if the user backed
 * out. Rejects when no scanner is reachable or the scan itself fails.
 */
export function scanQrCode(): Promise<string | null> {
  if (!global.isAndroid) return Promise.reject(new Error("QR scanning needs Android."));
  const activity = currentActivity();
  if (!activity) return Promise.reject(new Error("No foreground activity to scan from."));
  if (isMlKitScannerAvailable()) return scanWithMlKit(activity);
  if (isScanIntentAvailable()) return scanWithIntent(activity);
  return Promise.reject(new Error("No QR scanner available (needs Play Services or a scanner app)."));
}

function scanWithMlKit(activity: any): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    const listener = new com.faceclaw.app.FaceclawQrScannerListener({
      onResult: (text: string) => {
        if (settled) return;
        settled = true;
        resolve(String(text));
      },
      onCancelled: () => {
        if (settled) return;
        settled = true;
        resolve(null);
      },
      onError: (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(String(message)));
      },
    });
    try {
      com.faceclaw.app.FaceclawQrScanner.scan(activity, listener);
    } catch (error) {
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function scanWithIntent(activity: any): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const onResult = (args: { requestCode: number; resultCode: number; intent: any }) => {
      if (args.requestCode !== SCAN_REQUEST_CODE) return;
      Application.android.off(Application.android.activityResultEvent, onResult);
      if (args.resultCode !== android.app.Activity.RESULT_OK || !args.intent) {
        resolve(null);
        return;
      }
      const text = args.intent.getStringExtra("SCAN_RESULT");
      resolve(text === null || text === undefined ? null : String(text));
    };
    Application.android.on(Application.android.activityResultEvent, onResult);
    try {
      activity.startActivityForResult(buildScanIntent(), SCAN_REQUEST_CODE);
    } catch (error) {
      Application.android.off(Application.android.activityResultEvent, onResult);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
