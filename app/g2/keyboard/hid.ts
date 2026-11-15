/**
 * Bounded HID report-descriptor decoder for the keyboard bridge: turns a
 * keyboard's Report Map into the layout of each input report, and input
 * reports into the set of keys held. From the reference client in g2flash
 * demos/ (keyboard-hid.ts).
 *
 * HID over GATT carries the Report ID out of band (in each characteristic's
 * Report Reference descriptor), so byte zero of a report value is data: it is
 * never stripped as USB HID would. Only the keyboard/keypad page (7) and the
 * consumer page (12) produce keys; pointer axes and padding are ignored.
 * No platform imports: this runs under node in the tests.
 */

export type HidUsage = { page: number; usage: number };
export type HidKeyEvent = HidUsage & { down: boolean };

type Global = { page: number; min: number; max: number; size: number; count: number; id: number };
type Field = {
  bit: number;
  size: number;
  count: number;
  variable: boolean;
  min: number;
  max: number;
  usages: HidUsage[];
  range?: [HidUsage, HidUsage];
};
export type HidReport = { id: number; bits: number; fields: Field[] };

const HID_PAGE_KEYBOARD = 7;
const HID_PAGE_CONSUMER = 12;
const REPORT_MAP_MAX = 512;

function fail(reason: string): never {
  throw new Error(`Unsupported or malformed HID descriptor: ${reason}`);
}

const usageKey = (u: HidUsage): string => `${u.page}:${u.usage}`;

/** Input reports by Report ID (0 when the descriptor uses none). Throws on anything out of bounds. */
export function parseReportMap(bytes: Uint8Array): Map<number, HidReport> {
  if (!bytes.length || bytes.length > REPORT_MAP_MAX) fail("report map must contain 1..512 bytes");
  const reports = new Map<number, HidReport>();
  let g: Global = { page: 0, min: 0, max: 0, size: 0, count: 0, id: 0 };
  const stack: Global[] = [];
  let usages: HidUsage[] = [];
  let lo: HidUsage | undefined;
  let hi: HidUsage | undefined;
  let depth = 0;
  const usage = (v: number, n: number): HidUsage =>
    n === 4 ? { page: v >>> 16, usage: v & 65535 } : { page: g.page, usage: v };
  for (let p = 0; p < bytes.length;) {
    const prefix = bytes[p++]!;
    if (prefix === 0xfe) fail("long items");
    const n = [0, 1, 2, 4][prefix & 3]!;
    if (p + n > bytes.length) fail("truncated item");
    let v = 0;
    for (let j = 0; j < n; j++) v += bytes[p++]! * 2 ** (8 * j);
    const signed = n && v >= 2 ** (n * 8 - 1) ? v - 2 ** (n * 8) : v;
    const type = (prefix >> 2) & 3;
    const tag = prefix >> 4;
    if (type === 1) {
      switch (tag) {
        case 0: g.page = v; break;
        case 1: g.min = signed; break;
        case 2: g.max = g.min < 0 ? signed : v; break;
        case 7: g.size = v; break;
        case 8: if (!v || v > 255) fail("Report ID"); g.id = v; break;
        case 9: g.count = v; break;
        case 10: if (stack.length >= 8) fail("global stack overflow"); stack.push({ ...g }); break;
        case 11: if (!stack.length) fail("global stack underflow"); g = stack.pop()!; break;
        case 3: case 4: case 5: case 6: break; // physical range, unit and exponent
        default: fail("unknown global item");
      }
    } else if (type === 2) {
      if (tag === 0) { if (usages.length >= 512) fail("too many usages"); usages.push(usage(v, n)); }
      else if (tag === 1) lo = usage(v, n);
      else if (tag === 2) hi = usage(v, n);
      else if (tag === 10) fail("usage delimiters");
      else if (tag > 9) fail("unknown local item");
    } else if (type === 0) {
      if (tag === 10) { if (++depth > 32) fail("collection depth"); }
      else if (tag === 12) { if (--depth < 0) fail("collection underflow"); }
      else if (tag === 8) {
        if (!g.size || g.size > 32 || !g.count || g.count > 512) fail("field dimensions");
        let r = reports.get(g.id);
        if (!r) {
          if (reports.size >= 16) fail("too many input reports");
          r = { id: g.id, bits: 0, fields: [] };
          reports.set(g.id, r);
        }
        const field: Field = {
          bit: r.bits, size: g.size, count: g.count, variable: !!(v & 2), min: g.min, max: g.max, usages: [...usages],
        };
        if (lo || hi) {
          if (!lo || !hi || lo.page !== hi.page || hi.usage < lo.usage) fail("usage range");
          field.range = [lo!, hi!];
        }
        r.bits += g.size * g.count;
        if (r.bits > 4096) fail("report exceeds 512 bytes");
        // Constant padding and relative pointer axes are not keys.
        if (!(v & 1) && !(v & 4)) r.fields.push(field);
      } else if (tag !== 9 && tag !== 11) fail("unknown main item");
      usages = [];
      lo = hi = undefined;
    } else fail("reserved item type");
  }
  if (depth || stack.length) fail("unbalanced collection/global stack");
  if (reports.has(0) && reports.size > 1) fail("mixed numbered and unnumbered input reports");
  if (!reports.size) fail("no input reports");
  return reports;
}

function usageAt(f: Field, index: number): HidUsage | undefined {
  if (index < 0) return undefined;
  if (index < f.usages.length) return f.usages[index];
  const rangeIndex = index - f.usages.length;
  if (f.range && rangeIndex <= f.range[1].usage - f.range[0].usage) {
    return { page: f.range[0].page, usage: f.range[0].usage + rangeIndex };
  }
  // Variable items reuse their last usage when Report Count exceeds the usages.
  if (f.variable) return f.range?.[1] ?? f.usages[f.usages.length - 1];
  return undefined;
}

/**
 * Whether an input report can ever say a key is held. False for a pointer's
 * report (a trackpad or mouse on a combined device), whose movement would
 * otherwise be relayed, and thrown away, a hundred times a second.
 */
export function reportHasKeys(report: HidReport): boolean {
  const isKeyPage = (u: HidUsage): boolean => u.page === HID_PAGE_KEYBOARD || u.page === HID_PAGE_CONSUMER;
  return report.fields.some((f) => f.usages.some(isKeyPage) || (f.range !== undefined && isKeyPage(f.range[0])));
}

/** The keys one input report says are held. Throws on a length mismatch or a rollover report. */
export function reportKeys(report: HidReport, data: Uint8Array): HidUsage[] {
  if (data.length !== Math.ceil(report.bits / 8)) throw new Error("HID input length does not match Report Map");
  const keys = new Map<string, HidUsage>();
  for (const f of report.fields) {
    for (let i = 0; i < f.count; i++) {
      let value = 0;
      for (let j = 0; j < f.size; j++) {
        const bit = f.bit + i * f.size + j;
        if (data[bit >>> 3]! & (1 << (bit & 7))) value += 2 ** j;
      }
      if (f.min < 0 && value >= 2 ** (f.size - 1)) value -= 2 ** f.size;
      if (value < f.min || value > f.max) continue; // null state
      const u = usageAt(f, f.variable ? i : value - f.min);
      if (!u || (f.variable && value === 0) || !u.usage) continue;
      if (u.page === HID_PAGE_KEYBOARD && u.usage <= 3) throw new Error("HID keyboard rollover/error report");
      if (u.page === HID_PAGE_KEYBOARD || u.page === HID_PAGE_CONSUMER) keys.set(usageKey(u), u);
    }
  }
  return [...keys.values()];
}

/**
 * Held keys across a keyboard's input reports. Ownership is per report
 * characteristic, then unioned: releasing a key in one report cannot release
 * a modifier another report still holds.
 */
export class HidKeys {
  private reports = new Map<number, HidUsage[]>();
  private held = new Map<string, HidUsage>();

  /** Apply one report from characteristic `handle`; returns the transitions it caused. */
  update(handle: number, report: HidReport, data: Uint8Array): HidKeyEvent[] {
    this.reports.set(handle, reportKeys(report, data));
    return this.diff();
  }

  /** Release everything (a stream gap, a dropped link). */
  reset(): HidKeyEvent[] {
    this.reports.clear();
    return this.diff();
  }

  private diff(): HidKeyEvent[] {
    const next = new Map<string, HidUsage>();
    for (const values of this.reports.values()) for (const u of values) next.set(usageKey(u), u);
    const events: HidKeyEvent[] = [];
    for (const [k, u] of this.held) if (!next.has(k)) events.push({ ...u, down: false });
    for (const [k, u] of next) if (!this.held.has(k)) events.push({ ...u, down: true });
    this.held = next;
    return events;
  }
}
