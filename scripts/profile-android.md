# Android CPU profiling

Faceclaw can capture all three languages without adding instrumentation to the
app: Android Runtime (ART) sampling for Java/Kotlin, and V8 sampling for the
TypeScript compiled to JavaScript. The host script attaches to a running debug
build, records for a bounded duration, stops the profilers, and saves their files.
Nothing runs in the app when a capture is not active.

## Record

Use Node 22+ and `adb` on your PATH. Install and launch a **debug** build first.
For a new build, external source maps make capture extraction faster:

```sh
./build_and_run.sh --env.sourceMap=source-map
adb devices -l
npm run profile:android -- --device SERIAL --seconds 15
```

An existing debug build works too; the script also handles inline source maps.
No rebuild, app restart, Android Studio, root, or additional npm dependencies are
needed to record. Release APKs are not supported by this command.

Reproduce the slow operation after the command prints `Reproduce the workload
now`. Ctrl-C stops and saves early. Disconnect Chrome/NativeScript debuggers and
Android Studio CPU recordings first; this command needs exclusive profiler use.
If USB and wireless ADB both point to the same phone, select one with `--device`.
`ANDROID_SERIAL` also works, or omit the device when exactly one is connected.

```sh
# Java/Kotlin only, all threads in the app process
npm run profile:android -- --device SERIAL --mode art --seconds 15

# TypeScript/JavaScript only: main isolate and live NativeScript workers
npm run profile:android -- --device SERIAL --mode js --seconds 15

# Less frequent sampling (microseconds), with a named output directory
npm run profile:android -- --device SERIAL --interval 5000 --out profiles/scrolling
```

Default interval is 1,000 microseconds (1 ms); default duration is 10 seconds.
The output directory must not already exist. Captures go under git-ignored
`profiles/` by default. `--no-source-maps` skips source-map extraction.

## Read the results

| File | Contents | Viewer |
| --- | --- | --- |
| `java-kotlin.trace` | Sampled managed stacks across app threads, with Java and Kotlin method names | Android Studio Profiler: import/open a trace |
| `js-main.cpuprofile` | Main V8 isolate, locations mapped back to TypeScript where available | Chrome DevTools Performance: load profile, or [Speedscope](https://www.speedscope.app/) |
| `js-NS_WORKER_*.cpuprofile` | One profile per attached NativeScript worker | Same CPU-profile viewers |
| `*.raw.cpuprofile` | Original V8 profile with generated bundle locations and line ticks | Same CPU-profile viewers |
| `capture.json` | Worker names, capture parameters, sample counts, mapped-node counts, warnings | Text editor |
| `source-maps/` | Maps copied from the installed application, including embedded sources when available | Retained for interpreting the capture |

Use flame charts and bottom-up views to find expensive stacks. The worker URL in
`capture.json` identifies which app each numbered worker belongs to. Only raw
profiles are written with `--no-source-maps`; otherwise both versions are saved,
even when some locations cannot be mapped. Maps come from the installed app,
so a different local checkout cannot silently mislabel its frames.

## Coverage and interpretation

* **Java and Kotlin:** ART samples all managed threads in the app process,
  including shared Kotlin code packaged by `@faceclaw/kotlin`. Inlined Kotlin
  functions may appear as their callers. This is sampling, not an exact count
  of every method invocation.
* **TypeScript:** V8 samples the main isolate and workers already running or
  created during recording. Workers must survive until capture stops to return
  their profiles; exited workers are reported as warnings. Older NativeScript
  runtimes without worker auto-attach can still capture the main isolate.
* **Separate runtimes:** These are overlapping captures, not a single stitched
  cross-language call tree. Starts/stops have a small skew. V8 may show time
  inside a native bridge call; inspect ART to see the Java/Kotlin side. Embedded
  WebView JavaScript and native C/C++ stacks are outside this command's coverage.
* **Overhead:** Profiling changes timing, especially with both profilers active.
  Use separate `--mode js` / `--mode art` runs and larger intervals when needed.
  Keep the existing frame timings for end-to-end latency. Idle/background
  workers can return very few samples; exercise the code you want to measure.
* **Failures:** Raw profiles are saved before source mapping. `capture.json`
  reports partial captures and ART buffer overflow. On overflow, shorten the
  capture or increase the interval. Missing maps leave generated JS locations
  usable; build with `--env.sourceMap=source-map` for TypeScript locations.

On normal completion, Ctrl-C, or a handled capture error, the script attempts to
stop every profiler it started and removes its own ADB forwarding. A killed host
process or disconnected phone can prevent cleanup. Reconnect and stop ART with
`adb -s SERIAL shell am profile stop com.faceclaw.app`; restart the app if V8
profiling remains active. A failed pull leaves the trace at the device path
printed in the warning for manual recovery.

## Verified setup

Verified on a Pixel 7a running Android 16, with Faceclaw 0.7.2 and this checkout's
NativeScript Android 9.1.1 runtime. A 10-second capture produced Java/Kotlin
method data, a TypeScript-mapped main profile, and profiles for terminal and
Flappy Bird workers (Flappy was idle). No APK changes were required.

The implementation uses Android's `am profile start --sampling` / `stop` and
NativeScript's ADB-forwarded `PACKAGE-inspectorServer` WebSocket, with CDP
`Profiler` commands and flattened `Target.setAutoAttach` worker sessions.

References: [Android sampled method tracing](https://developer.android.com/studio/profile/generate-trace-logs),
[NativeScript debugging and profiling](https://docs.nativescript.org/guide/debugging),
[V8 inspector CPU profiling protocol](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/).
