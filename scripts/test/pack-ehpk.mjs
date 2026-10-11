#!/usr/bin/env node
/**
 * Pack a web-app directory into an EvenHub .ehpk, dependency-free (Node >= 22.15
 * for node:zlib zstd). Format reverse-engineered in
 * ../../ehpk-unpacker/ehpk_unpack.py and consumed by app/apps/evenhub/ehpk.ts:
 *
 *   header  "EHPK" | u16 major=1 | u16 minor=1 | u32 firstRecord=20
 *           | u32 recordCount | u32 reserved=0
 *   FILE    E4 BA A9 BA | u32 compLen | u32 uncompLen | u16 tag=0xB701
 *           | u16 nameLen | xor(path) | xor(zstd(content))
 *   DIR     E5 BA A9 BA | u16 tag=0xAABD | u16 nameLen | xor(path)
 *   FOOTER  E3 BA A9 BA | sha512 of every byte before this record
 *
 * Paths and content are XORed with the repeating key "EVEN REALITIES".
 * The manifest is stored as "app.json", project files under "dist/".
 *
 * Usage: node scripts/pack-ehpk.mjs <app.json> <projectDir> [-o out.ehpk]
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";

const KEY = Buffer.from("EVEN REALITIES", "ascii");

function xor(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) out[i] ^= KEY[i % KEY.length];
  return out;
}

function fileRecord(path, content) {
  const comp = xor(zstdCompressSync(content));
  const name = xor(Buffer.from(path, "utf8"));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(0xbaa9bae4, 0);
  head.writeUInt32LE(comp.length, 4);
  head.writeUInt32LE(content.length, 8);
  head.writeUInt16LE(0xb701, 12);
  head.writeUInt16LE(name.length, 14);
  return Buffer.concat([head, name, comp]);
}

function dirRecord(path) {
  const name = xor(Buffer.from(path, "utf8"));
  const head = Buffer.alloc(8);
  head.writeUInt32LE(0xbaa9bae5, 0);
  head.writeUInt16LE(0xaabd, 4);
  head.writeUInt16LE(name.length, 6);
  return Buffer.concat([head, name]);
}

function walk(dir, archivePrefix, records) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name.endsWith(".ehpk")) continue;
    const archivePath = `${archivePrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      records.push(dirRecord(archivePath));
      walk(join(dir, entry.name), archivePath, records);
    } else if (entry.isFile()) {
      records.push(fileRecord(archivePath, readFileSync(join(dir, entry.name))));
    }
  }
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("-o");
const output = outIndex >= 0 ? args.splice(outIndex, 2)[1] : "out.ehpk";
const [manifestPath, projectDir] = args;
if (!manifestPath || !projectDir) {
  console.error("usage: pack-ehpk.mjs <app.json> <projectDir> [-o out.ehpk]");
  process.exit(1);
}

const records = [fileRecord("app.json", readFileSync(manifestPath)), dirRecord("dist")];
walk(projectDir, "dist", records);

const header = Buffer.alloc(20);
header.write("EHPK", 0, "ascii");
header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 6);
header.writeUInt32LE(20, 8);
header.writeUInt32LE(records.length + 1, 12); // + footer
header.writeUInt32LE(0, 16);

const body = Buffer.concat([header, ...records]);
const footerHead = Buffer.alloc(4);
footerHead.writeUInt32LE(0xbaa9bae3, 0);
const footer = Buffer.concat([footerHead, createHash("sha512").update(body).digest()]);
writeFileSync(output, Buffer.concat([body, footer]));
console.log(`${output}: ${records.length + 1} records, ${body.length + footer.length} bytes`);
