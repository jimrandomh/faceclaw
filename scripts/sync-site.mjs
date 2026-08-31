#!/usr/bin/env node
// Keeps the website in step with the files that own the content.
//
//   website/content/features.md  ->  README.md  and  website/index.html
//   PRIVACY                      ->  website/privacy.html
//
// Each destination has a `<!-- BEGIN GENERATED: key -->` / `<!-- END GENERATED: key -->`
// pair; everything between them is replaced. Run after editing either source:
//
//   node scripts/sync-site.mjs           rewrite the destinations
//   node scripts/sync-site.mjs --check   exit non-zero if they are out of date

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const stale = [];

// ---------- generic helpers ----------

function splice(relPath, key, body) {
  const path = join(root, relPath);
  const before = readFileSync(path, "utf8");
  const begin = `<!-- BEGIN GENERATED: ${key} -->`;
  const end = `<!-- END GENERATED: ${key} -->`;
  const i = before.indexOf(begin);
  const j = before.indexOf(end);
  if (i < 0 || j < 0) throw new Error(`${relPath}: missing ${begin} / ${end} markers`);
  if (j < i) throw new Error(`${relPath}: ${end} comes before ${begin}`);
  const after = before.slice(0, i + begin.length) + "\n" + body.replace(/\n+$/, "") + "\n" + before.slice(j);
  if (after === before) return;
  if (check) stale.push(`${relPath} (${key})`);
  else writeFileSync(path, after);
}

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The small markdown subset the sources use: `code`, **bold**, [text](url), bare URLs.
function inlineHtml(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    // Bare URLs, minus any trailing sentence punctuation.
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+?)([.,;:)]?)(?=$|[\s<)])/g,
      (_, lead, url, tail) => `${lead}<a href="${url}">${url}</a>${tail}`);
}

function wrap(text, width, firstPrefix, contPrefix) {
  const lines = [];
  let line = firstPrefix;
  let indent = firstPrefix;
  for (const word of text.split(/\s+/)) {
    if (line !== indent && (line + " " + word).length > width) {
      lines.push(line);
      indent = contPrefix;
      line = contPrefix + word;
    } else {
      line = line === indent ? line + word : line + " " + word;
    }
  }
  lines.push(line);
  return lines.join("\n");
}

// ---------- features ----------

function parseFeatures(md) {
  const body = md.replace(/<!--[\s\S]*?-->/g, "");
  const features = [];
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (/^- /.test(line)) features.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && features.length) {
      features[features.length - 1] += " " + line.trim();
    }
  }
  if (!features.length) throw new Error("website/content/features.md: no `- ` bullets found");
  return features;
}

const features = parseFeatures(readFileSync(join(root, "website/content/features.md"), "utf8"));

splice("README.md", "features",
  features.map((f) => wrap(f, 78, " * ", "   ")).join("\n"));

splice("website/index.html", "features",
  '    <ul class="features">\n' +
  features.map((f) => `      <li>${inlineHtml(f)}</li>`).join("\n") +
  "\n    </ul>");

// ---------- privacy ----------

function privacyHtml(md) {
  const out = [];
  for (const block of md.trim().split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (/^# /.test(lines[0])) {
      out.push(`<h1>${inlineHtml(lines[0].slice(2).trim())}</h1>`);
    } else if (/^## /.test(lines[0])) {
      out.push(`<h2>${inlineHtml(lines[0].slice(3).trim())}</h2>`);
    } else if (lines.every((l) => /^\s{2,}\S/.test(l))) {
      // An indented run of "Provider: https://..." lines.
      out.push('<ul class="links">');
      for (const l of lines) out.push(`  <li>${inlineHtml(l.trim())}</li>`);
      out.push("</ul>");
    } else {
      out.push(`<p>${inlineHtml(lines.map((l) => l.trim()).join(" "))}</p>`);
    }
  }
  return out.map((l) => "    " + l).join("\n");
}

splice("website/privacy.html", "privacy",
  privacyHtml(readFileSync(join(root, "PRIVACY"), "utf8")));

// ---------- report ----------

if (check && stale.length) {
  console.error("Out of date, run `node scripts/sync-site.mjs`:\n  " + stale.join("\n  "));
  process.exit(1);
}
console.log(check ? "sync-site: up to date" : "sync-site: wrote generated blocks");
