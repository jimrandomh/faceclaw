# SDK releases and compatibility

## 0.3.0 candidate

- Add immutable typed contenders, priority, grants, dependencies and conflict reasons,
  with compatibility for older snapshots and unknown future reason codes.
- Remove fixed eight-app host connection/declaration limits; retain bounded IPC
  and reserve worst-case snapshot capacity before accepting declarations.
- Add the runnable conflict-status example and repository-local SDK candidate
  packaging with matching source, integrity checks and explicit local-review mode.
- Fail audit preflight before builds when the required toolchain is missing.
- Run APK CI on every PR and main push, including manifest/build-only changes.

- Add immutable typed host events and preserve the legacy JSON callback.
- Add `WindowState`, single-use `ProviderRequests`, and typed provider results.
- Move the starter and Java/Kotlin examples to typed callbacks. Ship consumer
  lifecycle tests that run without Android hardware.
- Add unique-package scaffolding, toolchain doctor, offline documentation link
  checks, and source provenance in portable kits.
- Publish configuration fields through the generated reference, including
  navigation `doubleTap`. Separate current acceptance from historical evidence.

The wire protocol remains 1 and extension semantics remain 2. SDK 0.2.0 apps
remain compatible with this host. SDK 0.3.0 ordinary windows can connect to a
protocol-1 host; global providers require advertised extension semantics 2.
Typed events are an app-side API addition, not a new host capability. Earlier
semantics require republishing declarations after upgrading to a compatible SDK.

## 0.2.0

Introduced the portable SDK repository, generated declarations, exact extension
semantics negotiation, per-feature epochs, developer diagnostics and standalone
starter. Historical validation reports record their own source/build revisions.

## Distribution policy

Use a new SDK coordinate for changed release contents. Do not overwrite an
existing version in a public Maven repository or replace an existing released
kit with different bytes. Preserve `PORTABLE-KIT.json` and both checksum files.
The manifest identifies source commit, dirty state, source-tree digest, protocol
and extension semantics. A dirty kit is local review evidence, not a release.

The repository's **SDK release candidate** workflow builds a kit and compatible
host APK from one checkout and uploads a downloadable archive and hashes to
that workflow run. It does not publish a GitHub release automatically. After
the acceptance ledger is complete, a maintainer can attach those unchanged
artifacts to an `sdk-v0.3.0` release and link it from the quickstart. There is no
claim that this candidate is already publicly released.

Checksums detect changed files; they do not authenticate the publisher. The SDK
retains its existing GPL-3.0 license and bundled font notices. Release artifacts
must keep those notices and the corresponding source archive.
