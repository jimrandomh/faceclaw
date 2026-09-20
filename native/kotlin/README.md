# Shared Kotlin

Both `main` and `ios-port` build the same Kotlin Multiplatform sources in
`native/kotlin/shared/src`. NativeScript's `before-prepare` hook builds an AAR
for Android or a static `FaceclawKit.xcframework` for iOS, then stages it in the
local `@faceclaw/kotlin` plugin. Generated binaries and Gradle caches are ignored.

- `commonMain/kotlin`: wire protocol, fragmentation/reassembly, event decoding,
  image/RLE/texture planning, retained surface composition, glyph/image atlases,
  LVGL font parsing, spectral noise suppression, PNG/GIF/WAV encodings and
  callback interfaces.
- `androidMain/kotlin`: monotonic clock, reentrant locks, JVM zlib and file I/O,
  zero-copy `ByteBuffer` readers, firmware hashing/file writes and WAV file storage.
- `iosMain/kotlin`: monotonic clock, recursive locks, native zlib and POSIX file
  reads, plus `NSData` facades for NativeScript's Objective-C bridge.

The `com.faceclaw.app` package, `@JvmStatic` methods and `@JvmField` properties
preserve existing Java/NativeScript callers. Android's `java.nio.ByteBuffer`
entry points for atlases/composition now take `AndroidByteReader`, keeping the
bulk buffer crossing without putting Java APIs in common code. iOS uses
`IosByteReader` and `NSData`; binary bridges avoid per-element JS/native calls.

## Platform boundaries

`ProtocolPlatform` supplies clocks, locks and persistent deflaters. `expect` /
`actual` functions select default platform services at compilation. Stateful
transports and caches retain reentrant locking; callbacks still run on their
caller's thread. The migration does not introduce implicit UI-thread dispatch.
`OutboundMessage` and `CfwMessageWindow` require their owner's synchronization.

`CfwTransport` uses ordered `SYNC_FLUSH` records with one persistent compression
context. Lens changes and replay resets reset that context. Owners can close it
explicitly; iOS also cleans up abandoned native allocations. GATT write modes
are mapped by platform adapters.

`migrated-java-sources.json` lists each removed Java source and its Kotlin
replacement. Android's build removes precisely those stale generated copies
before compilation. `android-java-boundaries.json` inventories every retained
Java file and its Android API boundary: services/receivers, GATT, media,
WebView, SQLite, rendering, networking and JNI. The sherpa-onnx Java classes
remain the vendored Android JNI ABI. PNG/GIF adapters retain only Android
storage responsibilities; their codecs are shared.

On `ios-port`, platform adapters route the existing TypeScript session and UI
logic through shared Kotlin for protocol builders, CRC/framing/reassembly,
event decoding, CFW compression/ACKs, changed-image regions, surface composition,
and LVGL glyphs. The original pure TypeScript implementations remain as Node
test references; NativeScript selects the `.ios.ts` native adapters. Features
not yet present in the iOS app can use the shared audio/recording and texture
classes without another Java port.

## Build and validation

Requires JDK 21, Android SDK 35 and the existing `wear/gradlew` wrapper. iOS
additionally requires macOS, Xcode and an arm64 simulator. Configure paths in
`build_paths.sh`. Both production and tests use Kotlin 2.4.20 and Android KMP
plugin 8.13.2.

```sh
npm ci
# Once when upgrading an existing generated Android platform to runtime 9.1.1:
npx nativescript platform clean android
npm run test:kotlin
npm run test:kotlin:ios
./build.sh
# In ios-port:
./scripts/ios.sh build ios --emulator
```

`tests/kotlin` compiles production sources directly. Common tests run on JVM
and iOS: wire vectors, framing/corruption/expiry, streaming compression, replay,
composition, PNG pixels, font glyphs, and Java SHA-256 golden outputs for DSP
and GIF. Android additionally runs the existing Java protocol fixtures and
concurrency checks; iOS exercises `NSData` and compositor adapters. Debug app
startup checks real NativeScript metadata and bidirectional callbacks, logging
`FACECLAW_KOTLIN_BRIDGE_PASS` and `FACECLAW_KOTLIN_PROTOCOL_PASS`.

These checks require no BLE hardware. Physical glasses/ring behavior still
needs device testing, particularly sustained rendering and microphone traffic.
