/**
 * Parsers for what Even Realities hardware puts in a BLE advertisement.
 *
 * ## G2 temple (confirmed by HCI capture)
 *
 * Manufacturer-specific AD record: `45 52` + SN(14, ASCII) + MAC(6, little-endian) + flag(1).
 * The `45 52` ("ER") bytes sit in the company-identifier field, which Android
 * parses as little-endian uint16 `0x5245`. Both arms of a pair advertise the
 * SAME serial; that is the pair identity. The local name is
 * `Even G2_<token>_<L|R>_<hex6>` where the trailing hex is the last three
 * bytes of THAT ARM's address — per-arm, NOT a pair id. One arm's name
 * predicts nothing about the other's.
 *
 * ## R1 ring
 *
 * `45 52` + MAC(6, wire order) and, on ring firmware 2.2.7.x, further bytes
 * after the MAC (observed live: the ASCII device-serial suffix, e.g. "140137").
 * The local name is `EVEN R1_<hex6>` where the hex is the last three octets
 * of the human-order MAC. Anchor on the marker and, when the name carries the
 * conventional suffix, require the candidate MAC to reproduce it — a naive
 * `suffix(6)` slice once captured serial digits as the ring identity.
 *
 * This module is pure (no NativeScript imports) so it can run under node tests.
 */

import { bytesToHex, hexToBytes } from "../util/hex-util";

export { bytesToHex, hexToBytes };

/** Even Realities' manufacturer-data company identifier (`"ER"` read little-endian). */
export const EVEN_COMPANY_IDENTIFIER = 0x5245;

export type EvenDeviceRole = "left" | "right" | "ring" | "rayneo-io";

/** The firmware an Even G1 arm advertises: Even's, or Faceclaw's g1v0 (in safe mode: only updates work). */
export type G1Firmware = "stock" | "g1v0" | "g1v0-safe";

/** True when the manufacturer data opens with Even's `"ER"` marker. */
export function hasEvenManufacturerSignature(mfg: Uint8Array): boolean {
  return mfg.length >= 2 && mfg[0] === 0x45 && mfg[1] === 0x52;
}

/**
 * Extract the serial number from G2 manufacturer data.
 * Layout: "ER"(2) + SN(14) + MAC(6, LE) + flag(1). Null when too short or when
 * the 14 bytes are not printable ASCII (control bytes are stripped, as the
 * SDK does, but a result that then fails to look like a serial is rejected).
 */
export function extractG2Serial(mfg: Uint8Array): string | null {
  if (mfg.length < 16) return null;
  let serial = "";
  for (let i = 2; i < 16; i++) {
    const byte = mfg[i]!;
    if (byte <= 0x1f || byte === 0x7f) continue;
    if (byte > 0x7e) return null;
    serial += String.fromCharCode(byte);
  }
  return serial.length ? serial : null;
}

/**
 * Extract the BLE MAC from G2 manufacturer data.
 * Layout: "ER"(2) + SN(14) + MAC(6, little-endian) + flag(1).
 * Returns "AA:BB:CC:DD:EE:FF" (big-endian, colon-separated).
 */
export function extractG2Mac(mfg: Uint8Array): string | null {
  if (mfg.length < 22) return null;
  return humanReadableAddressFromWireBytes(mfg.subarray(16, 22));
}

/** Preserve the final G2 manufacturer-data byte without guessing its meaning. */
export function extractG2AdvertisementFlag(mfg: Uint8Array): number | null {
  if (mfg.length < 23 || !hasEvenManufacturerSignature(mfg)) return null;
  return mfg[22]!;
}

/**
 * ## Even G1 arm
 *
 * On Even's firmware the name is `Even G1_<token>_<L|R>_<hex6>` and the manufacturer data `[01 right | 02 left]` +
 * the ASCII serial, zero-padded (the first two bytes read as a "company id" that differs per arm). On g1v0 the name
 * is `G1CFW_<L|R>_<hex6>` with the same digits and address as stock's, and the scan response holds company 0xFFFF, a
 * format byte (2), a flags byte (bit 3: safe mode), the firmware's version in three bytes, and the pair ID in ASCII:
 * the frame serial, the same on both arms. Before 0.5.66: `G1v0_L` or `G1v0_R` (`G1v0S_…` in safe mode), format 1, no
 * version.
 */
export function g1FromName(name: string | null | undefined): { side: "left" | "right"; firmware: G1Firmware } | null {
  if (!name) return null;
  const custom = /^G1CFW_([LR])_[0-9A-F]{6}$/i.exec(name.trim());
  if (custom) return { side: custom[1]!.toUpperCase() === "L" ? "left" : "right", firmware: "g1v0" };
  const g1v0 = /^G1V0(S?)_([LR])$/i.exec(name.trim());
  if (g1v0) {
    return {
      side: g1v0[2]!.toUpperCase() === "L" ? "left" : "right",
      firmware: g1v0[1] ? "g1v0-safe" : "g1v0",
    };
  }
  if (!/^EVEN G1_/i.test(name.trim())) return null;
  const side = g2SideFromName(name);
  return side ? { side, firmware: "stock" } : null;
}

/** What g1v0's pair record says beyond the serial; null when there is no record of a format that says it. */
export function parseG1Record(mfg: Uint8Array): { version: string; safeMode: boolean } | null {
  if (mfg.length < 7 || mfg[0] !== 0xff || mfg[1] !== 0xff || mfg[2] !== 2) return null;
  return { version: `${mfg[4]}.${mfg[5]}.${mfg[6]}`, safeMode: (mfg[3]! & 8) !== 0 };
}

/** The pair's serial from an arm's manufacturer data, on either firmware; null when absent. */
export function extractG1Serial(mfg: Uint8Array, firmware: G1Firmware): string | null {
  const record = mfg.length >= 4 && mfg[0] === 0xff && mfg[1] === 0xff;
  const start = firmware === "stock" ? 1 : record && mfg[2] === 2 ? 7 : record && mfg[2] === 1 ? 4 : -1;
  if (start < 0 || mfg.length <= start) return null;
  let serial = "";
  for (let i = start; i < mfg.length; i++) {
    const byte = mfg[i]!;
    if (byte === 0) break;
    if (byte < 0x20 || byte > 0x7e) return null;
    serial += String.fromCharCode(byte);
  }
  return serial.length ? serial : null;
}

/** RayNeo iO manufacturer data (company 0x5716, little-endian first): `[07][MAC x6]...`, outside pairing mode. */
export const RAYNEO_COMPANY_IDENTIFIER = 0x5716;

export function extractRayNeoMac(mfg: Uint8Array): string | null {
  if (mfg.length < 9 || mfg[0] !== 0x16 || mfg[1] !== 0x57 || mfg[2] !== 0x07) return null;
  return Array.from(mfg.subarray(3, 9), (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

/**
 * Which side a G2 temple advertisement belongs to, from the local name.
 * Null when the name carries neither or both markers.
 */
export function g2SideFromName(name: string | null | undefined): "left" | "right" | null {
  if (!name) return null;
  const upper = name.toUpperCase();
  const isLeft = upper.includes("_L_");
  const isRight = upper.includes("_R_");
  if (isLeft === isRight) return null;
  return isLeft ? "left" : "right";
}

/** "Even G2_32_L_ACD458" → "ACD458"; null when the name does not end in 6 hex digits. */
export function g2NameAddressTail(name: string | null | undefined): string | null {
  if (!name) return null;
  const match = /_([0-9A-F]{6})\s*$/i.exec(name);
  return match ? match[1]!.toUpperCase() : null;
}

/**
 * Even's wire order is reversed human order: "AA:BB:CC:DD:EE:FF" ⇄ [FF EE DD CC BB AA].
 */
export function wireBytesFromHumanReadableAddress(address: string): Uint8Array | null {
  const cleaned = address.replace(/[:-]/g, "").trim();
  if (cleaned.length !== 12 || !/^[0-9a-fA-F]{12}$/.test(cleaned)) return null;
  const human = hexToBytes(cleaned);
  return new Uint8Array(Array.from(human).reverse());
}

export function humanReadableAddressFromWireBytes(bytes: Uint8Array): string | null {
  if (bytes.length !== 6) return null;
  return Array.from(bytes)
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(":");
}

/**
 * The conventional R1 local name ("EVEN R1_B56EE2") ends in the human-order
 * MAC's last three octets. Returns those octets when the name carries a
 * parseable 6-hex-digit suffix. A bare ring id ("B56EE2") is accepted too.
 */
export function ringNameAddressOctets(name: string | null | undefined): number[] | null {
  if (!name) return null;
  const marker = name.indexOf("R1_");
  const suffix = (marker >= 0 ? name.slice(marker + 3) : name).trim();
  if (suffix.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(suffix)) return null;
  return [0, 2, 4].map((i) => parseInt(suffix.slice(i, i + 2), 16));
}

/**
 * A wire-order candidate is reversed(human), so its bytes [2],[1],[0] must
 * equal the name suffix octets in order for the candidate to belong to the
 * named ring.
 */
export function wireBytesMatchNameOctets(wire: ArrayLike<number>, nameOctets: number[]): boolean {
  return wire.length === 6 && nameOctets.length === 3 && wire[2] === nameOctets[0] && wire[1] === nameOctets[1] && wire[0] === nameOctets[2];
}

/**
 * Extract the ring's wire-order MAC from its manufacturer data, validated
 * against the advertised name when the name is verifiable. Fails closed
 * (null) when the name is verifiable and no 6-byte window reproduces it.
 */
export function ringMacWireBytes(mfg: Uint8Array, localName: string | null | undefined): Uint8Array | null {
  if (mfg.length < 6) return null;
  const markerAnchored = mfg.length >= 8 && hasEvenManufacturerSignature(mfg) ? mfg.subarray(2, 8) : null;
  const nameOctets = ringNameAddressOctets(localName);
  if (!nameOctets) {
    // No verifiable name: prefer the documented marker layout, else legacy suffix.
    return new Uint8Array(markerAnchored ?? mfg.subarray(mfg.length - 6));
  }
  if (markerAnchored && wireBytesMatchNameOctets(markerAnchored, nameOctets)) {
    return new Uint8Array(markerAnchored);
  }
  for (let start = 0; start + 6 <= mfg.length; start++) {
    const window = mfg.subarray(start, start + 6);
    if (wireBytesMatchNameOctets(window, nameOctets)) return new Uint8Array(window);
  }
  return null;
}

/**
 * Ring firmware 2.2.7.x appends the ASCII serial suffix after the MAC. Return
 * it when present (digits/uppercase letters only) so the row can show it.
 */
export function extractRingSerialSuffix(mfg: Uint8Array): string | null {
  if (!hasEvenManufacturerSignature(mfg) || mfg.length <= 8) return null;
  let text = "";
  for (let i = 8; i < mfg.length; i++) {
    const byte = mfg[i]!;
    if (byte < 0x30 || byte > 0x5a) return null;
    text += String.fromCharCode(byte);
  }
  return text.length ? text : null;
}

// ---------------------------------------------------------------------------
// Classification of a raw advertisement
// ---------------------------------------------------------------------------

/** What the Java scanner hands up: one advertisement (or one bonded device). */
export type RawAdvertisement = {
  address: string;
  /** Live local name from the scan record, falling back to the cached device name. */
  name: string;
  /** Full manufacturer-specific data including the 2-byte company id, as hex. Empty when absent. */
  manufacturerData: string;
  rssi: number | null;
  txPower: number | null;
  connectable: boolean | null;
  bonded: boolean;
  source: "scan" | "paired";
  seenAtMs: number;
};

/** One advertisement after the protocol knowledge has been applied. */
export type EvenAdvertisement = {
  address: string;
  name: string;
  role: EvenDeviceRole;
  /** G2: the 14-char pair serial. Ring: null (the ring's serial suffix is `ringSerialSuffix`). */
  serial: string | null;
  /** The address embedded in the manufacturer data, when present. Should equal `address`. */
  embeddedMac: string | null;
  /** True when the embedded MAC disagrees with the address the radio reported. */
  embeddedMacMismatch: boolean;
  flag: number | null;
  ringSerialSuffix: string | null;
  rssi: number | null;
  txPower: number | null;
  connectable: boolean | null;
  bonded: boolean;
  source: "scan" | "paired";
  seenAtMs: number;
  manufacturerData: string;
  /** Why an otherwise Even-looking advertisement could not be fully parsed. */
  note: string | null;
  /** Set on an Even G1 arm (role left or right): its firmware. */
  g1Firmware?: G1Firmware;
  /** The version g1v0 advertises (0.5.66+); absent when it doesn't say. */
  g1Version?: string;
};

/**
 * Classify a raw advertisement. Returns null for anything that is not an Even
 * Realities G2 temple or R1 ring. Admission mirrors the SDK: stock names
 * contain "G2"/"R1", but renamed firmware may not, so the "ER" manufacturer
 * signature is an equally strong admission path. The ring check is anchored to
 * the stock "EVEN R1…" prefix — a bare `R1` substring also matches unrelated
 * hardware ("Oppo Enco R1"), and every ring row is selectable, so a loose
 * match here saves a stranger's earbuds as the ring. Keep this in sync with
 * the Java pre-filter (FaceclawDeviceDiscovery.isAdmissible), which must stay
 * a superset of it.
 */
export function classifyAdvertisement(raw: RawAdvertisement): EvenAdvertisement | null {
  const mfg = hexToBytes(raw.manufacturerData);
  const name = raw.name ?? "";
  const upper = name.toUpperCase();
  const hasSignature = hasEvenManufacturerSignature(mfg);
  const looksLikeRing = /^EVEN R1([_ ]|$)/.test(upper);
  const looksLikeG2 = upper.includes("G2");
  const rayneoMac = extractRayNeoMac(mfg);
  const looksLikeRayNeo = upper.startsWith("RAYNEO") || rayneoMac !== null;

  const g1 = g1FromName(name);
  if (g1) {
    const serial = extractG1Serial(mfg, g1.firmware);
    const record = g1.firmware === "stock" ? null : parseG1Record(mfg);
    return {
      address: normalizeMacAddress(raw.address),
      name,
      role: g1.side,
      serial,
      embeddedMac: null,
      embeddedMacMismatch: false,
      flag: null,
      ringSerialSuffix: null,
      rssi: raw.rssi,
      txPower: raw.txPower,
      connectable: raw.connectable,
      bonded: raw.bonded,
      source: raw.source,
      seenAtMs: raw.seenAtMs,
      manufacturerData: raw.manufacturerData ?? "",
      note: serial ? null : "no serial in the advertisement (it may still be arriving)",
      g1Firmware: record?.safeMode ? "g1v0-safe" : g1.firmware,
      ...(record ? { g1Version: record.version } : {}),
    };
  }

  if (!looksLikeRing && !looksLikeG2 && !hasSignature && !looksLikeRayNeo) return null;

  if (looksLikeRayNeo && !hasSignature) {
    const address = normalizeMacAddress(raw.address);
    return {
      address,
      name,
      role: "rayneo-io",
      serial: null,
      embeddedMac: rayneoMac,
      embeddedMacMismatch: !!rayneoMac && rayneoMac !== address,
      flag: null,
      ringSerialSuffix: null,
      rssi: raw.rssi,
      txPower: raw.txPower,
      connectable: raw.connectable,
      bonded: raw.bonded,
      source: raw.source,
      seenAtMs: raw.seenAtMs,
      manufacturerData: raw.manufacturerData ?? "",
      note: null,
    };
  }

  const base = {
    address: normalizeMacAddress(raw.address),
    name,
    rssi: raw.rssi,
    txPower: raw.txPower,
    connectable: raw.connectable,
    bonded: raw.bonded,
    source: raw.source,
    seenAtMs: raw.seenAtMs,
    manufacturerData: raw.manufacturerData ?? "",
  };

  if (looksLikeRing) {
    const wire = mfg.length >= 6 ? ringMacWireBytes(mfg, name) : null;
    const embeddedMac = wire ? humanReadableAddressFromWireBytes(wire) : null;
    return {
      ...base,
      role: "ring",
      serial: null,
      embeddedMac,
      embeddedMacMismatch: !!embeddedMac && embeddedMac !== base.address,
      flag: null,
      ringSerialSuffix: extractRingSerialSuffix(mfg),
      note: mfg.length >= 6 && !wire ? "advertisement carried no name-consistent MAC window" : null,
    };
  }

  const side = g2SideFromName(name);
  if (!side) {
    // A G2-signature advertisement with no side marker cannot be placed in a pair.
    return null;
  }
  const serial = mfg.length >= 16 ? extractG2Serial(mfg) : null;
  const embeddedMac = extractG2Mac(mfg);
  let note: string | null = null;
  if (mfg.length === 0) note = "no manufacturer data (serial unknown)";
  else if (mfg.length < 16) note = `manufacturer data too short (${mfg.length} bytes); cannot extract a serial`;
  else if (!serial) note = "could not extract a serial from the manufacturer data";
  return {
    ...base,
    role: side,
    serial,
    embeddedMac,
    embeddedMacMismatch: !!embeddedMac && embeddedMac !== base.address,
    flag: extractG2AdvertisementFlag(mfg),
    ringSerialSuffix: null,
    note,
  };
}

/**
 * Canonical MAC form: uppercase, colon-separated. Anything that does not
 * contain exactly 12 hex digits is passed through trimmed and uppercased so
 * an obviously-wrong value stays visible instead of being silently mangled.
 * The single normalizer for every address comparison in the app — the stored
 * side (device-addresses.ts re-exports this) and the scanned side must agree
 * byte for byte or "is this the previously-paired device" checks break.
 */
export function normalizeMacAddress(value: string | null | undefined): string {
  const compact = (value ?? "")
    .trim()
    .replace(/[^0-9a-fA-F]/g, "")
    .toUpperCase();
  if (compact.length !== 12) return (value ?? "").trim().toUpperCase();
  return compact.match(/.{2}/g)!.join(":");
}
