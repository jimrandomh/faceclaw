/**
 * Which kind of build this is, for analytics: an official release, or one
 * compiled by somebody else. Official releases are signed with the key
 * scripts/release.sh uses; anything else was built by whoever installed it.
 */
import { Utils } from "@nativescript/core";

declare const android: any;
declare const java: any;

/**
 * `debug` is a debuggable build (build.sh / build_and_run.sh); `self-built`
 * is a release build signed with someone else's key.
 */
export type BuildKind = "official" | "self-built" | "debug" | "unknown";

/** SHA-256 of the release signing certificate (`apksigner verify --print-certs dist/Faceclaw-*.apk`). */
const OFFICIAL_SIGNING_CERT_SHA256 = "c1efe42d74f3fc4e9a13bcfc8c99e018344a55525e5b300fa960c89431e382ad";

let cached: BuildKind | null = null;

export function buildKind(): BuildKind {
  cached ??= detectBuildKind();
  return cached;
}

function detectBuildKind(): BuildKind {
  try {
    const context = Utils.android.getApplicationContext();
    const packageManager = context.getPackageManager();
    const PackageManager = android.content.pm.PackageManager;
    const signatures =
      android.os.Build.VERSION.SDK_INT >= 28
        ? packageManager
            .getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES)
            .signingInfo.getApkContentsSigners()
        : packageManager.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNATURES).signatures;
    for (let index = 0; index < signatures.length; index++) {
      const digest = java.security.MessageDigest.getInstance("SHA-256").digest(signatures[index].toByteArray());
      if (hex(digest) === OFFICIAL_SIGNING_CERT_SHA256) return "official";
    }
    const debuggable = (context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) !== 0;
    return debuggable ? "debug" : "self-built";
  } catch (error) {
    console.warn(`build-info: could not read the signing certificate: ${error}`);
    return "unknown";
  }
}

function hex(bytes: any): string {
  let text = "";
  for (let index = 0; index < bytes.length; index++) text += ((bytes[index] & 0xff) + 0x100).toString(16).slice(1);
  return text;
}
