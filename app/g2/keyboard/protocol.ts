/**
 * Wire format of the CFW keyboard bridge (Faceclaw/39). The master temple acts
 * as a BLE central for one HID-over-GATT keyboard; the phone drives that link
 * over private settings fields and gets the keyboard's raw input reports back.
 * The firmware side is g2flash patches/keyboard_core.h, documented in its
 * docs/keyboard.md. This follows the reference client in g2flash demos/
 * (keyboard-protocol.ts), which came with the firmware from tetramo-labs.
 *
 * Phone -> glasses, settings field 130 (wrapped by the native session):
 *   ['K','B',1,op, request LE16, epoch LE16, body...]    at most 80 bytes
 * Glasses -> phone, settings field 131:
 *   ['K','B',1,kind, sequence LE32, epoch LE16, request LE16, code LE16,
 *    handle LE16, total LE16, offset LE16, timestamp LE32, fragment...]
 *
 * All integers are little endian. No platform imports: this runs under node
 * in the tests.
 */

export const KEYBOARD_PROTOCOL_VERSION = 1;

/** Fixed part of a field-131 record, before its fragment. */
export const KEYBOARD_RECORD_HEADER = 24;
/** Most body bytes one record carries; longer bodies are fragmented. */
export const KEYBOARD_RECORD_CHUNK = 96;
/** Largest reassembled body (an ATT value or a HID report). */
export const KEYBOARD_BODY_MAX = 512;
/** Largest control body after the 8-byte prefix. */
export const KEYBOARD_CONTROL_BODY_MAX = 72;

export const KeyboardOp = {
  query: 0,
  enable: 1,
  disable: 2,
  scan: 3,
  connect: 4,
  disconnect: 5,
  pair: 6,
  auth: 7,
  compare: 8,
  find: 9,
  read: 10,
  write: 11,
  watch: 12,
} as const;
export type KeyboardOpCode = (typeof KeyboardOp)[keyof typeof KeyboardOp];

export const KeyboardKind = {
  status: 1,
  att: 2,
  input: 3,
  dm: 4,
  advert: 5,
} as const;

/** Control error codes, carried in a STATUS record's `code`. */
export const KeyboardError = {
  ok: 0,
  badRequest: 1,
  disabled: 2,
  busy: 3,
  staleEpoch: 4,
  noSpace: 5,
  notConnected: 6,
  notEncrypted: 7,
  timeout: 8,
  noMemory: 9,
} as const;

export function keyboardErrorName(code: number): string {
  switch (code) {
    case KeyboardError.ok: return "ok";
    case KeyboardError.badRequest: return "bad request";
    case KeyboardError.disabled: return "keyboard bridge disabled";
    case KeyboardError.busy: return "busy";
    case KeyboardError.staleEpoch: return "stale epoch";
    case KeyboardError.noSpace: return "no connection or bond space";
    case KeyboardError.notConnected: return "not connected";
    case KeyboardError.notEncrypted: return "not encrypted";
    case KeyboardError.timeout: return "timeout";
    case KeyboardError.noMemory: return "allocation failure";
    default: return `error ${code}`;
  }
}

/** Cordio device-manager events the bridge relays (a DM record's `code & 0xff`). */
export const KeyboardDm = {
  connOpen: 0x27,
  connClose: 0x28,
  pairComplete: 0x2a,
  pairFailed: 0x2b,
  encrypted: 0x2c,
  encryptFailed: 0x2d,
  authRequest: 0x2e,
  compare: 0x35,
} as const;

/** ATT client events (an ATT record's `code & 0xff`; the status is `code >> 8`). */
export const KeyboardAtt = {
  notification: 13,
  indication: 14,
} as const;

export type KeyboardRecord = {
  kind: number;
  sequence: number;
  epoch: number;
  request: number;
  code: number;
  handle: number;
  /** Glasses uptime in ms when the record was queued. */
  timestamp: number;
  data: Uint8Array;
};

export const u16 = (p: Uint8Array, off = 0): number => p[off]! | (p[off + 1]! << 8);
export const u32 = (p: Uint8Array, off = 0): number =>
  (p[off]! | (p[off + 1]! << 8) | (p[off + 2]! << 16) | (p[off + 3]! << 24)) >>> 0;
export const le16 = (v: number): number[] => [v & 255, (v >>> 8) & 255];

/** A field-130 control record. The session wraps it in the settings package. */
export function keyboardControl(op: number, request: number, epoch: number, body: readonly number[] = []): Uint8Array {
  if (!Number.isInteger(op) || op < 0 || op > KeyboardOp.watch || body.length > KEYBOARD_CONTROL_BODY_MAX) {
    throw new Error("Keyboard control bounds");
  }
  return Uint8Array.from([75, 66, KEYBOARD_PROTOCOL_VERSION, op, ...le16(request), ...le16(epoch), ...body]);
}

/**
 * Bounded, ordered reassembly of field-131 records. `onGap` fires whenever
 * the stream may have lost something (a skipped sequence, an epoch change, a
 * malformed or orphaned fragment): the caller then releases every held key
 * and fails any setup transaction in flight. The firmware's once-a-second
 * status record makes a lost final release visible even when no further keys
 * arrive.
 */
export class KeyboardRecords {
  private epoch: number | undefined;
  private last: number | undefined;
  private fragment: { record: KeyboardRecord; total: number; used: number } | undefined;

  constructor(private readonly onGap: () => void) {}

  /** Forget the stream position (the phone link dropped); counts as a gap. */
  reset(): void {
    this.epoch = undefined;
    this.last = undefined;
    this.fragment = undefined;
    this.onGap();
  }

  /** Feed one field-131 payload; returns a complete record, or undefined. */
  push(p: Uint8Array): KeyboardRecord | undefined {
    const invalid = (): undefined => {
      this.fragment = undefined;
      this.onGap();
      return undefined;
    };
    if (
      p.length < KEYBOARD_RECORD_HEADER || p.length > KEYBOARD_RECORD_HEADER + KEYBOARD_RECORD_CHUNK ||
      p[0] !== 75 || p[1] !== 66 || p[2] !== KEYBOARD_PROTOCOL_VERSION
    ) {
      return invalid();
    }
    const r: KeyboardRecord = {
      kind: p[3]!,
      sequence: u32(p, 4),
      epoch: u16(p, 8),
      request: u16(p, 10),
      code: u16(p, 12),
      handle: u16(p, 14),
      timestamp: u32(p, 20),
      data: new Uint8Array(0),
    };
    const total = u16(p, 16);
    const offset = u16(p, 18);
    const n = p.length - KEYBOARD_RECORD_HEADER;
    if (r.kind < KeyboardKind.status || r.kind > KeyboardKind.advert || total > KEYBOARD_BODY_MAX ||
        offset + n > total || (total > 0 && n === 0)) {
      return invalid();
    }
    if (this.epoch !== r.epoch) {
      this.onGap();
      this.fragment = undefined;
      this.last = undefined;
      this.epoch = r.epoch;
    }
    if (offset === 0) {
      if (this.last !== undefined) {
        const distance = (r.sequence - this.last) >>> 0;
        if (distance === 0 || distance >= 0x80000000) return undefined; // duplicate or old delivery
      }
      if (this.fragment || (this.last !== undefined && r.sequence !== ((this.last + 1) >>> 0))) this.onGap();
      this.last = r.sequence;
      this.fragment = { record: { ...r, data: new Uint8Array(total) }, total, used: 0 };
    }
    const f = this.fragment;
    if (!f || f.used !== offset || f.total !== total || f.record.sequence !== r.sequence ||
        f.record.kind !== r.kind || f.record.request !== r.request || f.record.code !== r.code ||
        f.record.handle !== r.handle || f.record.timestamp !== r.timestamp) {
      return invalid();
    }
    f.record.data.set(p.subarray(KEYBOARD_RECORD_HEADER), offset);
    f.used += n;
    if (f.used !== total) return undefined;
    this.fragment = undefined;
    return f.record;
  }
}

/** BLE address types as the controller reports them. */
export const KEYBOARD_ADDRESS_TYPES = ["public", "random", "public-identity", "random-identity"] as const;

/** One advertiser seen during a scan (an ADVERT record's body, parsed). */
export type KeyboardAdvert = {
  addressType: number;
  /** "aa:bb:cc:dd:ee:ff", most significant byte first. */
  address: string;
  rssi: number;
  name: string;
  /** Advertises the HID service, or a HID appearance. */
  hid: boolean;
};

/** ADVERT body: addrType, addr[6] (LSB first), RSSI, event type, AD length, AD structures. */
export function parseKeyboardAdvert(body: Uint8Array): KeyboardAdvert | null {
  if (body.length < 10 || body[0]! > 3) return null;
  let name = "";
  let hid = false;
  for (let i = 10; i < body.length;) {
    const n = body[i++]!;
    if (n === 0 || i + n > body.length) break;
    const type = body[i]!;
    if (type === 8 || type === 9) name = decodeUtf8(body.subarray(i + 1, i + n));
    // 16-bit service lists (incomplete / complete): 0x1812 is HID.
    if (type === 2 || type === 3) {
      for (let j = i + 1; j + 1 < i + n; j += 2) if (body[j] === 0x12 && body[j + 1] === 0x18) hid = true;
    }
    // Appearance 0x03C0..0x03FF is the HID category (0x03C1 keyboard); some
    // keyboards advertise that without the service list.
    if (type === 0x19 && n >= 3 && body[i + 2] === 0x03 && body[i + 1]! >= 0xc0) hid = true;
    i += n;
  }
  return {
    addressType: body[0]!,
    address: formatKeyboardAddress(body.subarray(1, 7)),
    rssi: (body[7]! << 24) >> 24,
    name,
    hid,
  };
}

/**
 * Fold a later record for the same advertiser into an earlier one. An active
 * scan reports the advertisement and its scan response separately and the
 * name usually only rides in the latter: keep a name once seen, HID once
 * seen, and the best signal.
 */
export function mergeKeyboardAdverts(a: KeyboardAdvert, b: KeyboardAdvert): KeyboardAdvert {
  return { ...a, rssi: Math.max(a.rssi, b.rssi), name: a.name || b.name, hid: a.hid || b.hid };
}

/** Controller byte order (LSB first) to the usual "aa:bb:cc:dd:ee:ff". */
export function formatKeyboardAddress(lsbFirst: Uint8Array): string {
  return Array.from(lsbFirst).reverse().map((b) => b.toString(16).padStart(2, "0")).join(":");
}

/** "aa:bb:cc:dd:ee:ff" to the controller's LSB-first bytes, or null if malformed. */
export function parseKeyboardAddress(text: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(text)) return null;
  return Uint8Array.from(text.split(":").reverse().map((part) => parseInt(part, 16)));
}

/** Lenient UTF-8 decode (advertised names); no TextDecoder in every runtime this loads in. */
function decodeUtf8(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++]!;
    let code = b;
    let extra = 0;
    if (b >= 0xf0 && b < 0xf8) { code = b & 0x07; extra = 3; }
    else if (b >= 0xe0) { code = b & 0x0f; extra = 2; }
    else if (b >= 0xc0) { code = b & 0x1f; extra = 1; }
    else if (b >= 0x80) { out += "�"; continue; }
    if (i + extra > bytes.length) { out += "�"; break; }
    let valid = true;
    for (let k = 0; k < extra; k++) {
      const c = bytes[i + k]!;
      if ((c & 0xc0) !== 0x80) { valid = false; break; }
      code = (code << 6) | (c & 0x3f);
    }
    if (!valid || code > 0x10ffff) { out += "�"; continue; }
    i += extra;
    if (code === 0) continue;
    out += String.fromCodePoint(code);
  }
  return out;
}
