/**
 * EvenHub .ehpk package unpacking.
 *
 * The .ehpk produced by `evenhub pack` (@evenrealities/evenhub-cli) is a
 * custom record container holding the app's dist/ tree plus app.json, each
 * entry zstd-compressed and XORed with the repeating ASCII key
 * "EVEN REALITIES" (key index resets per field). Format details are in
 * ../../../../ehpk-unpacker/ehpk_unpack.py, the reference implementation
 * this ports. The trailing record is a SHA-512 of everything before it —
 * an integrity check only, not a signature; we skip verifying it.
 */
import { decompress } from "fzstd";
import { parsePermissions, type EvenHubPermission } from "./permissions";

const XOR_KEY = "EVEN REALITIES";

const RECORD_FILE = 0xe4;
const RECORD_DIR = 0xe5;
const RECORD_FOOTER = 0xe3;

/** Archive paths are relative to one package, never to the phone container. */
export function safeEhpkPath(value: string): boolean {
  return !!value && !/[\\\u0000:]/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..');
}

export type EhpkArchive = {
  /** Relative path (e.g. "app.json", "dist/index.html") to contents. */
  files: Map<string, Uint8Array>;
};

/** The app.json manifest fields Faceclaw cares about (both spec generations). */
export type EvenHubManifest = {
  packageId: string;
  name: string;
  version: string;
  /** Entry file relative to dist/ (default index.html). */
  entrypoint: string;
  /** Hosts the app declares it will reach; not yet enforced. */
  networkWhitelist: string[];
  /** Normalized declared permissions (both manifest shapes). */
  permissions: EvenHubPermission[];
  /** App privacy policy, when a locally supplied manifest declares one. */
  privacyPolicyUrl: string;
  raw: Record<string, unknown>;
};

function unxor(data: Uint8Array, start: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = data[start + i]! ^ XOR_KEY.charCodeAt(i % XOR_KEY.length);
  }
  return out;
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1]! & 0x3f));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f));
      i += 3;
    } else {
      const cp =
        ((b & 0x07) << 18) | ((bytes[i + 1]! & 0x3f) << 12) | ((bytes[i + 2]! & 0x3f) << 6) | (bytes[i + 3]! & 0x3f);
      out += String.fromCodePoint(cp);
      i += 4;
    }
  }
  return out;
}

/** Index compressed records without expanding assets merely to read app.json. */
export function openEhpk(data: Uint8Array) {
  if (data.length < 20 || data[0] !== 0x45 || data[1] !== 0x48 || data[2] !== 0x50 || data[3] !== 0x4b)
    throw new Error("not an EHPK file");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records = new Map<string, { offset: number; compressed: number; size: number }>();
  const requireBytes = (offset: number, length: number) => {
    if (offset < 20 || length < 0 || offset + length > data.length) throw new Error("ehpk: truncated record");
  };
  let p = view.getUint32(8, true);
  requireBytes(p, 0);
  while (p < data.length) {
    requireBytes(p, 4);
    const type = data[p]!;
    if (data[p + 1] !== 0xba || data[p + 2] !== 0xa9 || data[p + 3] !== 0xba)
      throw new Error(`ehpk: bad record magic at ${p}`);
    if (type === RECORD_FILE) {
      requireBytes(p, 16);
      const compressed = view.getUint32(p + 4, true), size = view.getUint32(p + 8, true);
      const nameLength = view.getUint16(p + 14, true);
      requireBytes(p + 16, nameLength + compressed);
      const name = utf8Decode(unxor(data, p + 16, nameLength));
      if (!safeEhpkPath(name)) throw new Error(`ehpk: invalid file path ${name}`);
      records.set(name, { offset: p + 16 + nameLength, compressed, size });
      p += 16 + nameLength + compressed;
    } else if (type === RECORD_DIR) {
      requireBytes(p, 8);
      const length = view.getUint16(p + 6, true);
      requireBytes(p + 8, length); p += 8 + length;
    } else if (type === RECORD_FOOTER) break;
    else throw new Error(`ehpk: unknown record type 0x${type.toString(16)} at ${p}`);
  }
  return { files: {
    keys: () => records.keys(),
    has: (name: string) => records.has(name),
    get: (name: string): Uint8Array | undefined => {
      const record = records.get(name);
      if (!record) return undefined;
      const content = decompress(unxor(data, record.offset, record.compressed), new Uint8Array(record.size));
      if (content.length !== record.size) throw new Error(`ehpk: ${name}: expected ${record.size} bytes, got ${content.length}`);
      return content;
    },
  } };
}
export type EhpkIndex = ReturnType<typeof openEhpk>;

export function parseEhpk(data: Uint8Array): EhpkArchive {
  const index = openEhpk(data), files = new Map<string, Uint8Array>();
  for (const name of index.files.keys()) files.set(name, index.files.get(name)!);
  return { files };
}

/**
 * Parse app.json, accepting both the older manifest shape (permissions as a
 * {"network": [...]} map) and the current one (array of {name, whitelist?}).
 */
export function parseManifest(appJsonText: string): EvenHubManifest {
  const raw = JSON.parse(appJsonText) as Record<string, unknown>;
  const packageId = String(raw.package_id ?? raw.packageId ?? "unknown.package");
  const name = String(raw.name ?? packageId);
  const version = String(raw.version ?? "0");
  const entrypoint = String(raw.entrypoint ?? "index.html");
  if (!safeEhpkPath(entrypoint)) throw new Error('Invalid EHPK entrypoint');

  const permissions = parsePermissions(raw.permissions);
  const privacyPolicyUrl = firstSafeHttpsUrl(
    raw.privacy_link,
    raw.privacyLink,
    raw.privacy_policy_url,
    raw.privacyPolicyUrl,
  );
  const networkWhitelist: string[] = [];
  for (const permission of permissions) {
    if (permission.name === "network" && permission.whitelist) {
      networkWhitelist.push(...permission.whitelist);
    }
  }

  return { packageId, name, version, entrypoint, networkWhitelist, permissions, privacyPolicyUrl, raw };
}

function firstSafeHttpsUrl(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string" || value.length > 2048) continue;
    try {
      const url = new URL(value.trim());
      if (url.protocol === "https:") return url.toString();
    } catch {
      // Try the next supported manifest spelling.
    }
  }
  return "";
}
