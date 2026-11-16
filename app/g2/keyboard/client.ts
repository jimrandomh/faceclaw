/**
 * Transport-independent client for the CFW keyboard bridge: enable, scan,
 * connect and pair a keyboard through the glasses, discover its HID service
 * over the relayed ATT operations, subscribe its input reports, and decode
 * them into key transitions. From the reference client in g2flash demos/
 * (keyboard-client.ts), with the fixes its use in the Glassly app turned up.
 *
 * The firmware keeps almost no policy: it owns the connection and the bond,
 * and forwards one ATT request at a time. Everything HID lives here. Handle
 * numbers found by configure() are only good for one connection epoch.
 * No platform imports: this runs under node in the tests.
 */
import { HidKeys, parseReportMap, reportHasKeys, type HidKeyEvent, type HidReport } from "./hid";
import {
  KeyboardDm,
  KeyboardError,
  KeyboardKind,
  KeyboardOp,
  KeyboardRecords,
  keyboardControl,
  keyboardErrorName,
  le16,
  parseKeyboardAdvert,
  u16,
  u32,
  type KeyboardAdvert,
  type KeyboardRecord,
} from "./protocol";

/** Queue one field-130 control record; false when the glasses link can't take it now. */
export type KeyboardTransport = (record: Uint8Array) => boolean;

export type KeyboardStatus = {
  enabled: boolean;
  /** The firmware's connection id for the keyboard, 0 when it owns none. */
  conn: number;
  connected: boolean;
  encrypted: boolean;
  scanning: boolean;
};

export type KeyboardClientEvents = {
  /** Key transitions from one input report (or the releases a gap forces). */
  keys?(events: HidKeyEvent[]): void;
  advert?(advert: KeyboardAdvert): void;
  status?(status: KeyboardStatus): void;
  /** The stream may have lost records; held keys were released. */
  gap?(): void;
  /** Device-manager event from the glasses' BLE host (KeyboardDm). */
  dm?(event: number, status: number): void;
  /** The keyboard shows a six-digit passkey; answer with authenticate(). */
  passkeyRequest?(): void;
  /** We chose a passkey and answered with it; the user types it on the keyboard, then Enter. */
  passkeyDisplay?(pin: number): void;
  /** Numeric comparison: answer with confirm() once the user has compared. */
  compareRequest?(value: number): void;
  /** The keyboard's GATT table changed; the mapping is void until configure() runs again. */
  servicesChanged?(): void;
  error?(message: string): void;
  /** Setup diagnostics: the keyboard's attribute table and what was made of it. Never key contents. */
  log?(line: string): void;
};

export type KeyboardReport = {
  /** Handle of the HID service declaration the report belongs to. */
  service: number;
  handle: number;
  id: number;
  /** 1 input, 2 output, 3 feature. */
  type: number;
  ccc?: number;
  /** From the characteristic's declaration; undefined when the keyboard wouldn't say (see declaredProperties). */
  properties?: number;
  map: Uint8Array;
};

export type KeyboardConfiguration = {
  epoch: number;
  /** Every report found, input or not. */
  reports: KeyboardReport[];
  /** Handles of the input reports subscribed for keys. */
  watched: number[];
  serviceChanged?: number;
};

export type KeyboardClientOptions = {
  /** A fresh six-digit passkey for display pairing. Default: Math.random (pass a stronger source). */
  randomPasskey?: () => number;
};

export class KeyboardClientError extends Error {
  /** The firmware's control error code (KeyboardError), when that is what failed. */
  readonly code: number | undefined;
  /** The keyboard's ATT error code, when it refused a read or write. */
  readonly attStatus: number | undefined;
  constructor(message: string, code?: number, attStatus?: number) {
    super(message);
    this.name = "KeyboardClientError";
    this.code = code;
    this.attStatus = attStatus;
  }
}

type Attribute = { handle: number; uuid: number | string };
type Pending = {
  op: number;
  resolve: (r: KeyboardRecord) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Waiter = { test: () => boolean; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Input = { report: HidReport; id: number; service: number };

const COMMAND_TIMEOUT_MS = 32_000;
const MAX_PENDING = 8;
const MAX_ATTRIBUTES = 512;
const MAX_VALUE = 512;
const MAX_WATCHES = 16;

const UUID_PRIMARY_SERVICE = 0x2800;
const UUID_SECONDARY_SERVICE = 0x2801;
const UUID_CHARACTERISTIC = 0x2803;
const UUID_CCC = 0x2902;
const UUID_EXTERNAL_REPORT_REFERENCE = 0x2907;
const UUID_REPORT_REFERENCE = 0x2908;
const UUID_HID_SERVICE = 0x1812;
const UUID_SERVICE_CHANGED = 0x2a05;
const UUID_REPORT_MAP = 0x2a4b;
const UUID_REPORT = 0x2a4d;
const UUID_PROTOCOL_MODE = 0x2a4e;

/** ATT error codes that end a paged read rather than failing it. */
const ATT_INVALID_OFFSET = 7;
const ATT_NOT_LONG = 11;
const ATT_NOT_FOUND = 10;

/**
 * ATT UUIDs are little endian. A 128-bit UUID on the Bluetooth base collapses
 * to its 16-bit form; vendor UUIDs stay as hex strings.
 */
export function attributeUuid(bytes: Uint8Array): number | string {
  if (bytes.length === 2) return u16(bytes);
  if (bytes.length !== 16) throw new KeyboardClientError("Invalid ATT UUID length");
  const base = [0xfb, 0x34, 0x9b, 0x5f, 0x80, 0, 0, 0x80, 0, 0x10, 0, 0];
  if (base.every((v, i) => bytes[i] === v) && bytes[14] === 0 && bytes[15] === 0) return u16(bytes, 12);
  return Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
}

export class KeyboardClient {
  /** The firmware's connection generation; every control but QUERY/ENABLE must carry the live one. */
  epoch = 0;
  status: KeyboardStatus = { enabled: false, conn: 0, connected: false, encrypted: false, scanning: false };
  configuration: KeyboardConfiguration | undefined;

  private serial = 0;
  private closed = false;
  /** The link under connect() went away (close, failed open, failed pairing). */
  private linkLost = false;
  private readonly pending = new Map<number, Pending>();
  private readonly waiters = new Set<Waiter>();
  private readonly keys = new HidKeys();
  private inputs = new Map<number, Input>();
  private readonly records = new KeyboardRecords(() => this.gap());
  private readonly randomPasskey: () => number;

  constructor(
    private readonly transport: KeyboardTransport,
    private readonly events: KeyboardClientEvents = {},
    options: KeyboardClientOptions = {},
  ) {
    this.randomPasskey = options.randomPasskey ?? (() => Math.floor(Math.random() * 1_000_000));
  }

  // ---------- Inbound ----------

  /** Feed one field-131 payload, in arrival order. */
  accept(data: Uint8Array): void {
    if (this.closed) return;
    const r = this.records.push(data);
    if (!r) return;
    this.epoch = r.epoch;
    if (r.kind === KeyboardKind.status && r.data.length === 10) {
      this.status = {
        enabled: !!r.data[0], conn: r.data[1]!, connected: !!r.data[2], encrypted: !!r.data[3], scanning: !!r.data[4],
      };
      if (!this.status.enabled || !this.status.connected || !this.status.encrypted) this.release();
      this.events.status?.(this.status);
    }
    const pending = this.pending.get(r.request);
    if (pending && (r.kind === KeyboardKind.status || r.kind === KeyboardKind.att)) {
      this.pending.delete(r.request);
      clearTimeout(pending.timer);
      if (r.kind === KeyboardKind.status && r.code) {
        pending.reject(new KeyboardClientError(
          `Keyboard command ${opName(pending.op)}: firmware ${keyboardErrorName(r.code)}`, r.code));
      } else {
        pending.resolve(r);
      }
    }
    if (r.kind === KeyboardKind.dm) this.acceptDm(r);
    else if (r.kind === KeyboardKind.input) this.acceptInput(r);
    else if (r.kind === KeyboardKind.advert) {
      const advert = parseKeyboardAdvert(r.data);
      if (advert) this.events.advert?.(advert);
    }
    this.checkWaiters();
  }

  private acceptDm(r: KeyboardRecord): void {
    const event = r.code & 255;
    const status = r.code >>> 8;
    if (event === KeyboardDm.connClose || event === KeyboardDm.pairFailed || event === KeyboardDm.encryptFailed ||
        (event === KeyboardDm.connOpen && status !== 0)) {
      this.linkLost = true;
      this.gap();
      this.inputs.clear();
      this.configuration = undefined;
    }
    if (event === KeyboardDm.authRequest && r.data.length === 2) {
      if (r.data[0]) {
        this.command(KeyboardOp.disconnect).catch(() => {});
        this.events.error?.("This keyboard only pairs out of band, which isn't supported.");
      } else if (r.data[1]) {
        // KeyboardDisplay on our side: choose the passkey, show it, and
        // answer at once; the user types it on the keyboard.
        const pin = Math.min(999_999, Math.max(0, Math.floor(this.randomPasskey())));
        this.events.passkeyDisplay?.(pin);
        this.authenticate(pin).catch((e) => this.events.error?.(messageOf(e)));
      } else {
        this.events.passkeyRequest?.();
      }
    }
    if (event === KeyboardDm.compare && r.data.length === 4) this.events.compareRequest?.(u32(r.data));
    this.events.dm?.(event, status);
  }

  private acceptInput(r: KeyboardRecord): void {
    const changed = this.configuration?.serviceChanged;
    if (changed !== undefined && r.handle === changed) {
      this.gap();
      this.inputs.clear();
      this.configuration = undefined;
      this.events.servicesChanged?.();
      return;
    }
    const input = this.inputs.get(r.handle);
    if (!input || this.configuration?.epoch !== r.epoch) {
      this.gap();
      return;
    }
    try {
      const events = this.keys.update(r.handle, input.report, r.data);
      if (events.length) this.events.keys?.(events);
    } catch (e) {
      this.release();
      this.events.error?.(messageOf(e));
    }
  }

  private release(): void {
    const events = this.keys.reset();
    if (events.length) this.events.keys?.(events);
  }

  private gap(): void {
    this.release();
    this.events.gap?.();
    for (const [id, p] of this.pending) {
      if (p.op < KeyboardOp.find) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new KeyboardClientError("Keyboard stream gap during ATT transaction"));
    }
  }

  /** The phone's link to the glasses dropped: release held keys and fail everything in flight. */
  lostPhoneLink(): void {
    this.records.reset();
    this.cancel("Glasses link lost");
  }

  /** Stop for good; later accept() calls are ignored. */
  close(): void {
    if (this.closed) return;
    this.lostPhoneLink();
    this.closed = true;
  }

  private cancel(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new KeyboardClientError(reason));
    }
    this.pending.clear();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new KeyboardClientError(reason));
    }
    this.waiters.clear();
  }

  private checkWaiters(): void {
    for (const w of [...this.waiters]) {
      let done = false;
      try {
        done = w.test();
      } catch (e) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.reject(e instanceof Error ? e : new KeyboardClientError(String(e)));
        continue;
      }
      if (!done) continue;
      this.waiters.delete(w);
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  /** Resolve once `test` holds; it is re-evaluated after every accepted record. */
  private waitFor(test: () => boolean, timeoutMs: number, what: string): Promise<void> {
    if (this.closed) return Promise.reject(new KeyboardClientError("Keyboard client closed"));
    if (test()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        test, resolve, reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new KeyboardClientError(`Timed out waiting for ${what}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  // ---------- Commands ----------

  /** Send one control and await the STATUS or ATT record that answers it. */
  command(op: number, body: readonly number[] = []): Promise<KeyboardRecord> {
    if (this.closed) return Promise.reject(new KeyboardClientError("Keyboard client closed"));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new KeyboardClientError("Too many keyboard commands"));
    const request = this.serial = this.serial % 65535 + 1;
    return new Promise<KeyboardRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request);
        reject(new KeyboardClientError(`Keyboard command ${opName(op)} timed out`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(request, { op, resolve, reject, timer });
      let queued = false;
      try {
        queued = this.transport(keyboardControl(op, request, this.epoch, body));
      } catch {
        queued = false;
      }
      if (!queued) {
        clearTimeout(timer);
        this.pending.delete(request);
        reject(new KeyboardClientError("The glasses aren't ready for keyboard commands"));
      }
    });
  }

  async enable(): Promise<void> {
    await this.command(KeyboardOp.enable);
  }

  /** Disconnect the keyboard and stop the bridge; the bond stays. */
  async disable(): Promise<void> {
    await this.command(KeyboardOp.disable);
    this.release();
  }

  /** Ask for the firmware's state. Also the way to learn the live epoch: QUERY isn't epoch-checked. */
  async query(): Promise<KeyboardStatus> {
    await this.command(KeyboardOp.query);
    return this.status;
  }

  /**
   * Active scan for about five seconds; adverts arrive through events.advert.
   * The firmware only clears `scanning` once the stock scanner is idle again,
   * and a ring looking for its lens can hold that well past the window, so a
   * lingering flag is not an error: the adverts already delivered stand.
   */
  async scan(): Promise<void> {
    await this.command(KeyboardOp.scan);
    try {
      await this.waitFor(() => !this.status.scanning, 8000, "the scan to finish");
    } catch (e) {
      if (this.closed) throw e;
    }
  }

  /** Connect, then pair unless the link comes up encrypted. `address` is LSB first. */
  async connect(addressType: number, address: Uint8Array): Promise<void> {
    if (address.length !== 6 || !Number.isInteger(addressType) || addressType < 0 || addressType > 3) {
      throw new KeyboardClientError("Invalid BLE address");
    }
    this.release();
    this.inputs.clear();
    this.configuration = undefined;
    this.linkLost = false;
    await this.command(KeyboardOp.connect, [addressType, ...address]);
    await this.waitFor(() => this.status.connected || this.linkLost, 32_000, "the keyboard to connect");
    if (!this.status.connected) throw new KeyboardClientError("The keyboard didn't answer");
    if (!this.status.encrypted) {
      // The keyboard's own security request may have started pairing already.
      // BUSY is not success: the encrypted status below still decides.
      try {
        await this.command(KeyboardOp.pair);
      } catch (e) {
        if (!(e instanceof KeyboardClientError) || e.code !== KeyboardError.busy) throw e;
      }
      await this.waitFor(() => this.status.encrypted || this.linkLost, 65_000, "pairing to finish");
      if (!this.status.encrypted) throw new KeyboardClientError("Pairing with the keyboard failed");
    }
  }

  async disconnect(): Promise<void> {
    await this.command(KeyboardOp.disconnect);
    this.release();
  }

  /** Answer a pending passkey prompt. */
  async authenticate(pin: number): Promise<void> {
    if (!Number.isInteger(pin) || pin < 0 || pin > 999_999) throw new KeyboardClientError("Invalid pairing passkey");
    await this.command(KeyboardOp.auth, [pin & 255, (pin >>> 8) & 255, pin >>> 16]);
  }

  /** Answer a pending numeric comparison. */
  async confirm(accept: boolean): Promise<void> {
    await this.command(KeyboardOp.compare, [accept ? 1 : 0]);
  }

  private async att(op: number, body: readonly number[]): Promise<KeyboardRecord> {
    const r = await this.command(op, body);
    if (r.kind !== KeyboardKind.att) throw new KeyboardClientError("Expected keyboard ATT response");
    return r;
  }

  /** Read a whole attribute: Read, then Read Blob until a short or empty reply. Never assumes the MTU. */
  async read(handle: number): Promise<Uint8Array> {
    const parts: number[] = [];
    for (;;) {
      const r = await this.att(KeyboardOp.read, [...le16(handle), ...le16(parts.length)]);
      const status = r.code >>> 8;
      if (parts.length && (status === ATT_INVALID_OFFSET || status === ATT_NOT_LONG)) break;
      if (status) throw new KeyboardClientError(`ATT read ${handle}: ${status}`, undefined, status);
      if (!r.data.length) break;
      for (const b of r.data) parts.push(b);
      if (parts.length > MAX_VALUE) throw new KeyboardClientError("Attribute exceeds 512 bytes");
      if (parts.length === MAX_VALUE) break;
    }
    return Uint8Array.from(parts);
  }

  /** Read a short attribute once (a Report Reference, a declaration, a service UUID). */
  private async shortRead(handle: number): Promise<Uint8Array> {
    const r = await this.att(KeyboardOp.read, [...le16(handle), 0, 0]);
    if (r.code >>> 8) throw new KeyboardClientError(`ATT read ${handle}: ${r.code >>> 8}`, undefined, r.code >>> 8);
    return r.data;
  }

  /** Write 1..18 bytes (an output report such as the LEDs, a CCC, the protocol mode). */
  async write(handle: number, value: Uint8Array, withoutResponse = false): Promise<void> {
    if (!value.length || value.length > 18) throw new KeyboardClientError("Keyboard write supports 1..18 bytes");
    const r = await this.att(KeyboardOp.write, [...le16(handle), withoutResponse ? 1 : 0, value.length, ...value]);
    if (r.code >>> 8) throw new KeyboardClientError(`ATT write ${handle}: ${r.code >>> 8}`, undefined, r.code >>> 8);
  }

  private async attributes(): Promise<Attribute[]> {
    const attrs: Attribute[] = [];
    let start = 1;
    while (start <= 65535) {
      const r = await this.att(KeyboardOp.find, [...le16(start), 255, 255]);
      const status = r.code >>> 8;
      if (status === ATT_NOT_FOUND) break; // the normal end of the table
      if (status) throw new KeyboardClientError(`ATT Find Information: ${status}`);
      const width = r.data[0] === 1 ? 4 : r.data[0] === 2 ? 18 : 0;
      if (!width || r.data.length <= 1 || (r.data.length - 1) % width) {
        throw new KeyboardClientError("Malformed Find Information response");
      }
      for (let i = 1; i < r.data.length; i += width) {
        const handle = u16(r.data, i);
        if (handle < start || attrs.length >= MAX_ATTRIBUTES) throw new KeyboardClientError("Invalid or excessive GATT handles");
        attrs.push({ handle, uuid: attributeUuid(r.data.subarray(i + 2, i + width)) });
        start = handle + 1;
      }
    }
    return attrs;
  }

  /**
   * The properties byte of a characteristic, from its declaration, or
   * undefined when the keyboard won't say. A GATT client normally learns
   * declarations through Read By Type, which the bridge doesn't relay, so
   * this reads the declaration attribute itself. Most stacks answer that
   * with the full declaration. Some keep only the properties byte there and
   * build the rest for Read By Type alone (older Telink SDKs, common in
   * small keyboards), and some refuse the read. None of that is a reason to
   * turn a keyboard away: the report's handle and UUID are already known.
   */
  private async declaredProperties(attrs: readonly Attribute[], a: Attribute): Promise<number | undefined> {
    const decl = attrs.filter((d) => d.handle < a.handle && d.uuid === UUID_CHARACTERISTIC).pop();
    if (!decl) return undefined;
    let declaration: Uint8Array;
    try {
      declaration = await this.shortRead(decl.handle);
    } catch (e) {
      const status = attRefusal(e);
      this.events.log?.(`declaration ${decl.handle} of ${a.handle}: read refused (ATT ${status})`);
      return undefined;
    }
    if (declaration.length === 5 || declaration.length === 19) {
      if (u16(declaration, 1) === a.handle && attributeUuid(declaration.subarray(3)) === a.uuid) return declaration[0]!;
      this.events.log?.(`declaration ${decl.handle} of ${a.handle}: describes something else (${hex(declaration)})`);
      return undefined;
    }
    if (declaration.length === 1) return declaration[0]!;
    this.events.log?.(`declaration ${decl.handle} of ${a.handle}: unexpected value (${hex(declaration)})`);
    return undefined;
  }

  /**
   * Discover every HID service, its Report Map and each report's Report
   * Reference; select Report Protocol and subscribe the input reports that
   * can carry keys. Needs an encrypted link. No handle is assumed.
   *
   * Only what typing needs is required of the keyboard: a Report Map that
   * parses, and at least one key-bearing input report with a Report
   * Reference and a CCC. A report that can't be placed is skipped and
   * logged, as is anything wrong with an external report (the battery
   * level, usually).
   */
  async configure(): Promise<KeyboardConfiguration> {
    const epoch = this.epoch;
    const log = (line: string): void => this.events.log?.(line);
    // A new discovery replaces any earlier mapping, whether or not it succeeds.
    this.release();
    this.inputs.clear();
    this.configuration = undefined;
    const attrs = await this.attributes();
    log(`gatt ${attrs.map((a) => `${a.handle}=${typeof a.uuid === "number" ? a.uuid.toString(16) : a.uuid}`).join(" ")}`);
    const reports: KeyboardReport[] = [];
    const watched: KeyboardReport[] = [];
    const skipped: string[] = [];
    const descriptorsFor = (handle: number): Attribute[] => {
      const end = attrs.find((a) => a.handle > handle &&
        (a.uuid === UUID_PRIMARY_SERVICE || a.uuid === UUID_SECONDARY_SERVICE || a.uuid === UUID_CHARACTERISTIC))?.handle ?? 65536;
      return attrs.filter((a) => a.handle > handle && a.handle < end);
    };
    /** Why a report was left out; the link going away is not a reason to carry on. */
    const skip = (a: Attribute, reason: string): void => {
      skipped.push(`${a.handle}: ${reason}`);
      log(`report ${a.handle} skipped: ${reason}`);
    };
    const addReport = async (service: number, a: Attribute, map: Uint8Array, parsed: Map<number, HidReport>) => {
      if (reports.some((r) => r.handle === a.handle)) return skip(a, "already listed by another HID service");
      const descriptors = descriptorsFor(a.handle);
      const ref = descriptors.find((d) => d.uuid === UUID_REPORT_REFERENCE);
      if (!ref) return skip(a, "no Report Reference descriptor");
      let reference: Uint8Array;
      try {
        reference = await this.shortRead(ref.handle);
      } catch (e) {
        return skip(a, `Report Reference ${ref.handle} unreadable (ATT ${attRefusal(e)})`);
      }
      if (reference.length !== 2) return skip(a, `Report Reference ${ref.handle} is ${hex(reference) || "empty"}`);
      const id = reference[0]!;
      const type = reference[1]!;
      if (type < 1 || type > 3) return skip(a, `Report Reference type ${type}`);
      const ccc = descriptors.find((d) => d.uuid === UUID_CCC)?.handle;
      const properties = await this.declaredProperties(attrs, a);
      const report: KeyboardReport = { service, handle: a.handle, id, type, ccc, properties, map };
      if (type === 1) {
        const layout = parsed.get(id);
        if (!layout) return skip(a, `input report id ${id} is not in the Report Map`);
        if (ccc === undefined || (properties !== undefined && !(properties & 0x10))) return skip(a, "input report can't notify");
        if (reportHasKeys(layout)) watched.push(report);
        else log(`report ${a.handle} (id ${id}) carries no keys; not subscribed`);
      }
      reports.push(report);
      log(`report ${a.handle}: id ${id} type ${type} ccc ${ccc ?? "-"} properties ${properties ?? "?"}`);
    };
    for (let i = 0; i < attrs.length; i++) {
      const service = attrs[i]!;
      if (service.uuid !== UUID_PRIMARY_SERVICE) continue;
      if (attributeUuid(await this.shortRead(service.handle)) !== UUID_HID_SERVICE) continue;
      const end = attrs.slice(i + 1).find((a) => a.uuid === UUID_PRIMARY_SERVICE || a.uuid === UUID_SECONDARY_SERVICE)?.handle ?? 65536;
      const members = attrs.filter((a) => a.handle > service.handle && a.handle < end);
      const mapAttr = members.find((a) => a.uuid === UUID_REPORT_MAP);
      if (!mapAttr) throw new KeyboardClientError(`HID service ${service.handle} has no Report Map`);
      const map = await this.read(mapAttr.handle);
      log(`report map ${mapAttr.handle}: ${hex(map)}`);
      const parsed = parseReportMap(map);
      for (const mode of members.filter((a) => a.uuid === UUID_PROTOCOL_MODE)) {
        try {
          await this.write(mode.handle, Uint8Array.of(1), true);
        } catch (e) {
          // Report Protocol is the default after a connection; a keyboard
          // that won't take the write is almost certainly in it already.
          log(`protocol mode ${mode.handle}: write refused (ATT ${attRefusal(e)})`);
        }
      }
      for (const a of members.filter((m) => m.uuid === UUID_REPORT)) await addReport(service.handle, a, map, parsed);
      // HOGP lets a Report Map refer to reports in other services (commonly Battery).
      for (const ext of descriptorsFor(mapAttr.handle).filter((a) => a.uuid === UUID_EXTERNAL_REPORT_REFERENCE)) {
        let value: Uint8Array;
        try {
          value = await this.shortRead(ext.handle);
        } catch (e) {
          log(`external report reference ${ext.handle} skipped: unreadable (ATT ${attRefusal(e)})`);
          continue;
        }
        if (value.length !== 2 && value.length !== 16) {
          log(`external report reference ${ext.handle} skipped: value ${hex(value) || "empty"}`);
          continue;
        }
        const uuid = attributeUuid(value);
        for (const a of attrs.filter((m) => m.uuid === uuid && (m.handle < service.handle || m.handle >= end))) {
          await addReport(service.handle, a, map, parsed);
        }
      }
    }
    if (this.closed || this.epoch !== epoch) throw new KeyboardClientError("The keyboard link changed during setup");
    if (!watched.length) {
      throw new KeyboardClientError(reports.length || skipped.length
        ? `No usable keyboard input report (${skipped.join("; ") || "none carries keys"})`
        : "This device has no HID service");
    }
    if (watched.length > MAX_WATCHES) throw new KeyboardClientError("Keyboard has more than 16 input reports");
    const changed = attrs.find((a) => a.uuid === UUID_SERVICE_CHANGED);
    const changedCcc = changed && descriptorsFor(changed.handle).find((a) => a.uuid === UUID_CCC);
    const watches = watched.map((r) => r.handle);
    if (changed && changedCcc && watches.length < MAX_WATCHES) watches.push(changed.handle);
    const serviceChanged = changed && changedCcc && watches.includes(changed.handle) ? changed.handle : undefined;
    const config: KeyboardConfiguration = { epoch: this.epoch, reports, watched: watched.map((r) => r.handle), serviceChanged };
    this.restore(config);
    try {
      await this.command(KeyboardOp.watch, [watches.length, ...watches.flatMap(le16)]);
      if (serviceChanged !== undefined) {
        try {
          await this.write(changedCcc!.handle, Uint8Array.of(2, 0));
        } catch (e) {
          log(`service changed ${changedCcc!.handle}: subscription refused (ATT ${attRefusal(e)})`);
        }
      }
      for (const r of watched) await this.write(r.ccc!, Uint8Array.of(1, 0));
    } catch (e) {
      this.inputs.clear();
      this.configuration = undefined;
      this.release();
      throw e;
    }
    return config;
  }

  /**
   * Install a mapping found by configure(). It is only good while the glasses
   * keep the same connection (the same epoch): after a keyboard reconnect or
   * a firmware boot, discover again.
   */
  restore(config: KeyboardConfiguration): void {
    if (!config.reports.length || config.reports.length > 64) throw new KeyboardClientError("Invalid keyboard configuration");
    const inputs = new Map<number, Input>();
    for (const r of config.reports) {
      if (r.type !== 1 || !config.watched.includes(r.handle)) continue;
      if (!Number.isInteger(r.handle) || r.handle < 1 || r.handle > 65535 || inputs.has(r.handle)) {
        throw new KeyboardClientError("Invalid restored Report handle");
      }
      if (!r.map.length || r.map.length > MAX_VALUE) throw new KeyboardClientError("Invalid restored Report Map");
      const report = parseReportMap(r.map).get(r.id);
      if (!report) throw new KeyboardClientError("Restored Report ID missing");
      inputs.set(r.handle, { report, id: r.id, service: r.service });
    }
    if (!inputs.size || inputs.size > MAX_WATCHES) throw new KeyboardClientError("Invalid restored input count");
    this.release();
    this.inputs = inputs;
    this.configuration = config;
  }

  /** Output reports of the configured keyboard (the LED report is the usual one). */
  outputReports(): KeyboardReport[] {
    return this.configuration?.reports.filter((r) => r.type === 2) ?? [];
  }
}

/**
 * The ATT error code when `error` is the keyboard refusing a read or write.
 * Anything else (the link dropping, a timeout, a stream gap) is rethrown:
 * those end the setup, where a refusal only costs the one attribute.
 */
function attRefusal(error: unknown): number {
  if (error instanceof KeyboardClientError && error.attStatus !== undefined) return error.attStatus;
  throw error;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function opName(op: number): string {
  for (const [name, value] of Object.entries(KeyboardOp)) if (value === op) return name;
  return String(op);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
