import { Application } from "@nativescript/core";
import { fetchWithUserAgent } from "../../util/http";

declare const android: any;
declare const androidx: any;
declare const java: any;

const MAX_POLICY_BYTES = 10_000_000;
const POLICY_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Open an app privacy policy on the phone, using a native viewer for PDFs. */
export function openPrivacyPolicyOnPhone(value: string, appName: string): boolean {
  const url = safeHttpsUrl(value);
  const activity = Application.android?.foregroundActivity ?? Application.android?.startActivity;
  if (!url || !activity) return false;

  if (isPdfUrl(url)) {
    void downloadAndOpenPdf(url, appName, activity).catch((error) => {
      console.warn(`evenhub: could not open privacy policy PDF: ${error}`);
      if (!openExternalUrl(url, activity)) {
        showOpenError(activity, appName);
      }
    });
    return true;
  }

  showWebPolicy(url, appName, activity);
  return true;
}

/** Show an untrusted HTML policy in an isolated, bridge-free phone WebView. */
function showWebPolicy(url: string, appName: string, activity: any): void {
  const webView = new android.webkit.WebView(activity);
  const settings = webView.getSettings();
  settings.setJavaScriptEnabled(true);
  settings.setDomStorageEnabled(true);
  settings.setAllowFileAccess(false);
  webView.setWebViewClient(new android.webkit.WebViewClient());

  const container = new android.widget.FrameLayout(activity);
  const displayHeight = activity.getResources().getDisplayMetrics().heightPixels;
  container.addView(
    webView,
    new android.widget.FrameLayout.LayoutParams(
      android.view.ViewGroup.LayoutParams.MATCH_PARENT,
      Math.max(1, Math.round(displayHeight * 0.72)),
    ),
  );

  const dialog = new android.app.AlertDialog.Builder(activity)
    .setTitle(`${appName} privacy policy`)
    .setView(container)
    .setNegativeButton("Close", null)
    .create();
  dialog.setOnDismissListener(
    new android.content.DialogInterface.OnDismissListener({
      onDismiss: () => webView.destroy(),
    }),
  );
  dialog.show();
  const window = dialog.getWindow();
  if (window) {
    window.setLayout(
      android.view.ViewGroup.LayoutParams.MATCH_PARENT,
      android.view.ViewGroup.LayoutParams.MATCH_PARENT,
    );
  }
  webView.loadUrl(url);
}

async function downloadAndOpenPdf(url: string, appName: string, activity: any): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("Privacy policy download timed out.")), POLICY_DOWNLOAD_TIMEOUT_MS);
  });
  let response: Response;
  try {
    response = await Promise.race([fetchWithUserAgent(url), timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  if (!response.ok) throw new Error(`Privacy policy download failed (HTTP ${response.status}).`);
  const declaredSize = Number(response.headers.get("Content-Length") ?? 0);
  if (declaredSize > MAX_POLICY_BYTES) throw new Error("Privacy policy PDF is unexpectedly large.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 5 || bytes.length > MAX_POLICY_BYTES || !hasPdfMagic(bytes)) {
    throw new Error("Privacy policy response is not a valid PDF.");
  }

  const directory = new java.io.File(activity.getCacheDir(), "privacy-policies");
  if (!directory.exists() && !directory.mkdirs()) throw new Error("Could not create the privacy policy cache.");
  const hash = Number(new java.lang.String(url).hashCode()) >>> 0;
  const file = new java.io.File(directory, `policy-${hash.toString(16)}.pdf`);
  const stream = new java.io.FileOutputStream(file);
  try {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    stream.getChannel().write(buffer);
  } finally {
    stream.close();
  }

  const authority = `${activity.getPackageName()}.fileprovider`;
  const contentUri = androidx.core.content.FileProvider.getUriForFile(activity, authority, file);
  const intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
  intent.setDataAndType(contentUri, "application/pdf");
  intent.setClipData(android.content.ClipData.newRawUri("Privacy policy", contentUri));
  intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
  activity.startActivity(android.content.Intent.createChooser(intent, `${appName} privacy policy`));
}

function openExternalUrl(url: string, activity: any): boolean {
  try {
    const intent = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
    intent.addCategory(android.content.Intent.CATEGORY_BROWSABLE);
    activity.startActivity(intent);
    return true;
  } catch (error) {
    console.warn(`evenhub: no browser available for privacy policy: ${error}`);
    return false;
  }
}

function showOpenError(activity: any, appName: string): void {
  new android.app.AlertDialog.Builder(activity)
    .setTitle(`${appName} privacy policy`)
    .setMessage("No app is available to display this privacy policy PDF.")
    .setPositiveButton("Close", null)
    .show();
}

function isPdfUrl(value: string): boolean {
  try {
    return new URL(value).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

function safeHttpsUrl(value: string): string {
  if (!value || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}
