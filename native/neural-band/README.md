# Neural Band Android driver

The Android driver connects to a Meta Neural Band that Air Gestures has already
set up on the same phone. In Air Gestures, export the pairing file and release
the active connection. Then open Faceclaw's Neural Band settings, import the
file and tap **Connect**. Faceclaw uses the Android bond matching that file and
keeps the pairing key in app-private storage excluded from backups.

The driver uses GATT to obtain the input channel and the Rust library to run
the encrypted L2CAP session. The Rust workspace comes from
[Rokid Lumen at 4fe237668683cbe7e613e3c0121723a9f176102a](https://github.com/beyondlevi/rokid-lumen/tree/4fe237668683cbe7e613e3c0121723a9f176102a/rust),
with changes for Faceclaw. See `band-core/ORIGIN.md` for the Air Gestures and
kinesis lineage, and `THIRD-PARTY-NOTICES.txt` for the locked Android
dependencies. The tutorial panels were rendered by Faceclaw with demonstration
content. The setup screen's small vector icons are from Lucide. The original
licenses are included.

## Optional Android build

Use PowerShell 7, Rust 1.88 or later with the `aarch64-linux-android` target
and Android NDK r28c or compatible. Set `ANDROID_NDK_HOME` and run from the
repository root:

```powershell
./native/neural-band/build-android.ps1 -OutputDirectory App_Resources/Android/src/main/jniLibs
cargo test --manifest-path native/neural-band/Cargo.toml --locked --workspace
```

Then run the normal Android app build. NativeScript packages the generated
`arm64-v8a/liblumen_band.so` from `App_Resources`. The generated library is
ignored by Git. Faceclaw exposes the Band feature only on Android 12 or later
when the library loads successfully. The Kotlin class name
`dev.lumen.band.Bridge` and its native method names are part of the JNI ABI.
