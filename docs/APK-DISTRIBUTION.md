# Prepare the SDK inside this repository

All SDK source, standalone templates, validation, packaging and release preparation
live here. No separate SDK repository or public Maven service is required. Generated
artifacts live in ignored build directories; do not commit AARs, APKs or archives.

## Local developer kit

Select JDK 21 and Android SDK 35, then run from the repository root:

```sh
python3 android-sdk/scripts/doctor.py
android-sdk/scripts/export-portable-kit.sh dist/faceclaw-sdk-0.3.0
python3 dist/faceclaw-sdk-0.3.0/tools/create-app.py dist/faceclaw-sdk-0.3.0 ../weather-app --package dev.example.weather --name Weather
```

The kit contains the Maven dependency, starter, documentation, examples, generated
contracts, licenses and integrity manifest. The new app no longer needs this host
checkout. Exports refuse to overwrite an existing directory.

## Audited candidate with compatible host

```sh
APK_AUDIT_OUTPUT="$PWD/android-sdk/build/distribution-audit" scripts/audit-apk-platform.sh --allow-known-upstream-failures
npx nativescript build android --no-hmr
python3 android-sdk/scripts/package-sdk-candidate.py \
  --audit android-sdk/build/distribution-audit \
  --host-apk platforms/android/app/build/outputs/apk/debug/app-debug.apk \
  --output dist/sdk-candidate
```

Run the audit and host build from the same source, and provide the resulting host
APK. Packaging verifies kit integrity, audit success, source revision, dirty state
and the complete source-tree digest. It refuses changed source, failed audits and
existing destinations. It creates the SDK archive, corresponding source archive,
host APK, audit/provenance records, `CANDIDATE.json` and `SHA256SUMS.txt` locally.
It does not install, upload or publish anything. Hashes identify artifacts; they
do not independently prove that a supplied host APK was built from that source.

For review before committing, add `--allow-dirty`. This records
`localReviewOnly: true` and archives the actual audited working source, including
new files, rather than silently archiving the previous commit. Such a bundle is
not an immutable release. Do not edit source between audit and packaging.

The repository's **SDK release candidate** workflow calls the same packaging
command without `--allow-dirty`, then uploads workflow artifacts for maintainer
review. Publication is a separate maintainer action after the
[acceptance ledger](APK-ACCEPTANCE.md) is complete. This work does not require
publication to an external service or imply that physical acceptance passed.

The scoped upstream test allowance remains visible in `audit.json`. A successful
package does not turn those failures into passing tests. Use a new SDK coordinate
when publishing changed contents after an immutable version has been released.
