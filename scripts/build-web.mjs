#!/usr/bin/env node
// Builds the browser demo (app/web/; see its README) into dist-web/, a static
// site. Host it anywhere that serves files; it needs no special headers.
//
//   node scripts/build-web.mjs                 Kotlin/JS, then the bundles
//   node scripts/build-web.mjs --skip-kotlin   reuse the last Kotlin/JS output
//   node scripts/build-web.mjs --serve         also serve it on :8123, rebuilding the TS on change
//   node scripts/build-web.mjs --out=DIR       write somewhere else
//
// `.web.ts` files stand in for their `.ts` siblings, like the iOS build's
// `.ios.ts`. App workers prefer `.webworker.ts`: they have no compositor, Kotlin
// or localStorage, so what they can't do there is forwarded to the main thread.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
const has = (name) => process.argv.includes(`--${name}`);
const out = resolve(root, argument("out") ?? "dist-web");
const app = join(root, "app");
const kotlinOut = join(root, "native/kotlin/shared/build/compileSync/js/main/productionExecutable/kotlin");
const kotlinEntry = join(kotlinOut, "FaceclawKotlin-shared.mjs");

function buildKotlin() {
  // JAVA_HOME and friends come from build_paths.sh, as for the other builds.
  const command = `source scripts/before_build.sh >/dev/null && cd native/kotlin && ../../wear/gradlew :shared:compileProductionExecutableKotlinJs --console=plain --quiet`;
  const result = spawnSync("bash", ["-c", command], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Kotlin/JS build failed");
}

/** Bundled read-only files, relative to assets/ (and to /app in the virtual filesystem). */
function collectAssets() {
  const copies = [];
  const walk = (dir, accept) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, accept);
      else if (accept(path)) copies.push({ from: path, to: relative(app, path).split(sep).join("/") });
    }
  };
  walk(join(app, "fonts/terminus"), (path) => extname(path) === ".bdf");
  walk(join(app, "fonts/terminusv"), (path) => extname(path) === ".bdf");
  walk(join(app, "fonts/ttf"), (path) => [".ttf", ".otf"].includes(extname(path)));
  walk(join(app, "images"), () => true);
  for (const doc of ["README.md", "LICENSE", "PRIVACY", "ACKNOWLEDGEMENTS.md"]) {
    copies.push({ from: join(root, doc), to: `about/${doc}` });
  }
  return copies;
}

const assets = collectAssets();

const define = {
  // `global` is NativeScript's globalThis; the platform flags fold their branches away.
  global: "globalThis",
  "global.isAndroid": "false",
  "global.isIOS": "false",
  "global.isWeb": "true",
  __ANDROID__: "false",
  __IOS__: "false",
  __DEV__: "false",
  __FACECLAW_ASSETS__: JSON.stringify(assets.map((asset) => asset.to)),
};

const alias = {
  "@nativescript/core/globals": join(app, "web/empty.ts"),
  "@nativescript/core/http": join(app, "web/nativescript-http.ts"),
  "@nativescript/core": join(app, "web/nativescript-core.ts"),
  "faceclaw-kit": kotlinEntry,
};

const common = {
  bundle: true,
  absWorkingDir: root,
  tsconfig: "tsconfig.json",
  target: "es2022",
  platform: "browser",
  define,
  alias,
  sourcemap: has("serve"),
  minify: !has("serve"),
  legalComments: "none",
  logLevel: "warning",
  logOverride: { "direct-eval": "silent", "commonjs-variable-in-esm": "silent" },
};

const WORKER_LITERAL = /new Worker\(\s*(["'])(\.\.?\/[^"']+)\1\s*\)/g;
const workerName = (path) => relative(app, path).split(sep).join("_").replace(/\.worker$/, "");
const workerEntries = new Map();

/** `new Worker("./x.worker")` literals become named lookups; the loaded ones get bundled next. */
const workerLiterals = {
  name: "faceclaw-worker-literals",
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async (args) => {
      if (!args.path.startsWith(app)) return undefined;
      const source = await readFile(args.path, "utf8");
      if (!source.includes("new Worker(")) return { contents: source, loader: "ts" };
      return {
        loader: "ts",
        contents: source.replace(WORKER_LITERAL, (_match, _quote, target) => {
          const path = resolve(dirname(args.path), target);
          const entry = ["", ".ts"].map((suffix) => path + suffix).find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
          if (!entry) throw new Error(`Worker not found: ${target} from ${args.path}`);
          const name = workerName(path);
          workerEntries.set(name, entry);
          return `(globalThis.__faceclawNewWorker(${JSON.stringify(name)}))`;
        }),
      };
    });
  },
};

async function buildPage() {
  mkdirSync(join(out, "workers"), { recursive: true });
  const main = await esbuild.build({
    ...common,
    entryPoints: { faceclaw: join(app, "web/main.ts") },
    outdir: out,
    format: "iife",
    resolveExtensions: [".web.ts", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    plugins: [workerLiterals],
    metafile: true,
  });
  await esbuild.build({
    ...common,
    entryPoints: Object.fromEntries(workerEntries),
    outdir: join(out, "workers"),
    format: "iife",
    resolveExtensions: [".webworker.ts", ".web.ts", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
  });
  cpSync(join(root, "website/images/favicon.png"), join(out, "favicon.png"));
  for (const name of readdirSync(join(app, "web/page"))) {
    const target = name === "worker-loader.js" ? join(out, "workers", name) : join(out, name);
    cpSync(join(app, "web/page", name), target, { recursive: true });
  }
  return main.metafile;
}

function copyAssets() {
  for (const asset of assets) {
    const target = join(out, "assets", asset.to);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(asset.from, target);
  }
}

function report(metafile) {
  if (has("analyze")) {
    writeFileSync(join(out, "meta.json"), JSON.stringify(metafile));
    console.log(`Wrote ${join(out, "meta.json")}`);
  }
  const size = (path) => (statSync(path).size / 1024).toFixed(0);
  console.log(`Page ${size(join(out, "faceclaw.js"))} KB, ${workerEntries.size} workers. Output in ${relative(root, out)}/`);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

function serve(port) {
  createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relativePath = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const path = join(out, relativePath);
    if (!path.startsWith(out) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    response.end(await readFile(path));
  }).listen(port, () => console.log(`Serving on http://localhost:${port}/`));
}

if (!has("skip-kotlin") || !existsSync(kotlinEntry)) buildKotlin();
rmSync(out, { recursive: true, force: true });
copyAssets();
report(await buildPage());

if (has("serve")) {
  serve(Number(argument("port") ?? 8123));
  // Rebuild on any app/ change; Kotlin changes need a restart without --skip-kotlin.
  const { watch } = await import("node:fs");
  let timer = null;
  watch(app, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      buildPage().then(report).catch((error) => console.error(error.message));
    }, 150);
  });
}
