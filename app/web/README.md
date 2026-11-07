# Browser demo

Faceclaw in a web page, for people deciding whether to install it: the real shell
and apps on simulated glasses, with no Bluetooth and no account. Output is a static
site with no server side, so any file host works (no special headers needed).

    ./build_web.sh            # Kotlin/JS and bundles, into dist-web/
    ./build_web.sh --serve    # also serve on :8123, rebuilding TS on change
    npm run typecheck:web     # typecheck the twins against their callers

`--serve` skips minification and writes source maps. Kotlin changes need a restart.
Pass `--skip-kotlin` to reuse the last Kotlin/JS output.

## How it fits together

It is a third host next to Android and iOS, and borrows iOS's shape:

| | Android | iOS | Browser |
|---|---|---|---|
| Host | `dashboard-controller.ts` | `ios-preview-controller.ts` | `web-controller.ts` |
| Platform twins | `x.ts` | `x.ios.ts` | `x.web.ts`, `x.webworker.ts` |
| Compositor | shared Kotlin (JVM) | shared Kotlin (native) | shared Kotlin (JS, `native/kotlin/shared/src/jsMain`) |
| App workers | isolates | isolates | Web Workers |
| Phone UI | `app/phone-ui/` | `app/phone-ui/` | `page.ts`, `page/` |

`scripts/build-web.mjs` is esbuild with these extras:

- `.web.ts` wins over `.ts` (workers try `.webworker.ts` first).
- `@nativescript/core` is aliased to `nativescript-core.ts`, the subset the app uses.
- `global.isAndroid` and `global.isIOS` are defined `false`, so their branches fold
  away, and `global.isWeb` is `true`.
- `new Worker("./x.worker")` literals become named worker bundles.

**Workers.** On the phones, a worker calls into objects shared across isolates. Web
Workers share nothing, so those calls become messages that `workers.ts` handles before
`WorkerAppHost` sees them: frames, settings writes and atlas registrations. A worker
boots from `page/worker-loader.js`, which waits for a settings snapshot before running
the bundle, because app modules read settings while evaluating.

**Atlas ids.** Draw records refer to fonts and images by id, and a worker can't ask the
main thread for one synchronously. So `texture-ids.ts` derives the id from the key the
atlases are keyed by anyway, in every context, and `GlyphAtlas.assignFontId` /
`ImageAtlas.ensureWithId` adopt it.

**Files.** `vfs.ts` has bundled assets under `/app` and writable documents under
`/documents` (saved to IndexedDB on the main thread). Reads are synchronous because
font loaders run during module evaluation: `main.ts` preloads what starting up reads
before it requires the app, and anything else is a synchronous XHR.

**Fonts and icons.** These must also be synchronous, which rules out CSS fonts and
`<img>`. `font-renderer.web.ts` uses opentype.js with an OffscreenCanvas;
`svg-rasterizer.web.ts` draws icon shapes with Path2D. `image-files.web.ts` decodes PNG
only, as `createImageBitmap` is asynchronous.

## What's real and what isn't

Real: the launcher, the shell and every app listed in `apps/all-apps.web.ts` except the
`phoneOnlyApp` entries. Weather fetches live forecasts for a fixed location.

Simulated, in `demo-data/`: notifications, calendar, music (no audio), battery levels,
compass heading, Nightscout (a fake server behind `http.web.ts`, on first opening the
app) and Terminal (a scripted fake host behind `g2mirror-client.webworker.ts`).

Left out, as `phoneOnlyApp` entries that explain themselves: AI Chat, T3 Code,
Transcribe, Translate, Microphones, Navigate, Roam, Developer and EvenHub. Voice input
is off throughout (`voiceInputEnabled: false`). Settings shows only the sections with
something behind them. The demo sends no analytics.

Timers are real but only ring while the page is open.

## Adding things

A new native call in shared code needs a twin if the web bundle reaches it. To find
out, build with `--analyze` and look through `dist-web/meta.json`; `typecheck:web`
catches a twin that has fallen out of step with its callers. A new app goes in
`apps/all-apps.web.ts` as well as `all-apps.ts`, which `tests/web-demo.test.cjs` checks.
