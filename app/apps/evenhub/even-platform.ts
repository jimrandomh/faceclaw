import { Application } from "@nativescript/core";

export function hmacSha256Base64(secret: string, message: string): string {
  const charset = java.nio.charset.StandardCharsets.UTF_8;
  const key = new javax.crypto.spec.SecretKeySpec(new java.lang.String(secret).getBytes(charset), "HmacSHA256");
  const mac = javax.crypto.Mac.getInstance("HmacSHA256");
  mac.init(key);
  const digest = mac.doFinal(new java.lang.String(message).getBytes(charset));
  return String(android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP));
}

export function getPhoneOpenUdid(): string {
  const resolver = Application.android.context?.getContentResolver();
  const id = resolver ? String(android.provider.Settings.Secure.getString(resolver, android.provider.Settings.Secure.ANDROID_ID) ?? "") : "";
  if (!id) throw new Error("Android did not provide a device ID for EvenHub authentication.");
  return id;
}
