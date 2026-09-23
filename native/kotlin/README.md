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
replacement (paths relative to the repository root). Android's build removes
precisely those stale generated copies before compilation. The Android-only
classes (services/receivers, GATT, media, WebView, SQLite, rendering,
networking, JNI engines) are Kotlin in
`App_Resources/Android/src/main/java/com/faceclaw/app/`, compiled by
NativeScript's own `kotlin-android` plugin rather than this KMP module; they keep
their Java-era JVM API (`@JvmStatic`/`@JvmField`/`const val`) so TypeScript and
the manifest are unchanged. `android-java-boundaries.json` inventories the Java
that remains: the sherpa-onnx classes, which are the vendored Android JNI ABI.
PNG/GIF adapters retain only Android storage responsibilities; their codecs are
shared.

On `ios-port`, platform adapters route the existing TypeScript session and UI
logic through shared Kotlin for protocol builders, CRC/framing/reassembly,
event decoding, CFW compression/ACKs, changed-image regions, surface composition,
and LVGL glyphs. The original pure TypeScript implementations remain as Node
test references; NativeScript selects the `.ios.ts` native adapters.

Texture rendering uses the same `GlyphAtlas`, `ImageAtlas`, `TextureCacheState`
and `TexturePlanner` on both platforms. iOS's `IosTextureAtlas` and
`IosTexturePlanner` expose bulk `NSData` bridges. Surface updates retain draw
identities through composition, including worker replies; immutable composite
snapshots keep those identities paired with the pixels while frames coalesce.
The BLE session plans only frames it will enqueue, sends mode-18 uploads before
the mode-19/20 draw batch, and counts a frame only after all uploads and draws
are acknowledged by both lenses. Session failure/teardown resets residency;
resuming near the firmware's 90-second lease deadline restarts the session
before queued draws can reference a freed cache. In either case,
the next frame reuploads lazily. Plans over the CFW message limit fall back to
pixel bands and invalidate any unsent allocations. The 256 KiB bump allocator
and reset-on-full policy are unchanged; there is no pinning or individual eviction.

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
concurrency checks; common texture tests cover reuse, overflow, reset and 32-bit
offsets, and iOS exercises `NSData`, atlas, compositor and planner adapters. Debug app
startup checks real NativeScript metadata and bidirectional callbacks, logging
`FACECLAW_KOTLIN_BRIDGE_PASS` and `FACECLAW_KOTLIN_PROTOCOL_PASS`.

These checks require no BLE hardware. Physical glasses/ring behavior still
needs device testing, particularly sustained rendering and microphone traffic.
