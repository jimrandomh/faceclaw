import { getStringSetting, setStringSetting } from "../../native/settings-store";
declare const FaceclawCrypto: any;

export function hmacSha256Base64(secret: string, message: string): string {
  return FaceclawCrypto.hmacSha256Message(secret, message);
}

/** A stable random terminal ID, independent of phone hardware identifiers. */
export function getPhoneOpenUdid(): string {
  const key = "integrations.evenhub.terminalId";
  let id = getStringSetting(key, "");
  if (!id) {
    id = NSUUID.UUID().UUIDString.replace(/-/g, "").slice(0, 16).toLowerCase();
    setStringSetting(key, id);
  }
  return id;
}
