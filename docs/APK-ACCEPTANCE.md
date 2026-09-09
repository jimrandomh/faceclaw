# APK platform acceptance ledger

This is the current acceptance checklist. Dated demo reports remain historical
evidence for their recorded revisions; they do not certify later builds.
SDK 0.3.0 keeps protocol 1 and extension semantics 2.

## Automated gates

Run `scripts/audit-apk-platform.sh --allow-known-upstream-failures` from the host
repository. It records source revision and dirty state, validates generated
contracts and tooling, runs host checks, SDK unit/assemble/lint, verifies kit
checksums and links, and builds the standalone starter, two uniquely scaffolded
apps, and the shipped examples outside the host checkout. Consumer lifecycle
tests run in the scaffolded projects.

The eight exact names in `known-host-test-failures.txt` are a scoped upstream
baseline allowance. A passing audit with that allowance is not a fully green
host suite. Any other failure remains fatal. Retire entries as upstream fixes
them. The toolchain doctor requires JDK 21 and Android SDK 35.

The APK platform workflow tests native separate-UID boundaries and the seven
independent-APK scenarios on API 26 and API 35 emulators. API 26 covers the
byte-array path; API 35 covers SharedMemory. Remote CI execution must pass on
the actual PR revision. Local tests do not imply remote CI has run.

## Device gates

The full checklist is in the SDK priority-demo `DEVICE-CHECKLIST.md`. Record the
host and app APK hashes, SDK version, phone/Android version, glasses firmware,
and the exact steps observed. Keep emulator, phone preview and lens evidence
separate. Never install test-only consent fixtures on a physical phone.

| Case | Required observation on the candidate build |
| --- | --- |
| P01–P04 | Competing typography, base edit under override, independent feature winners, declaration toggles. |
| P05–P08 | Live/static outage, offline revocation, withdrawal/uninstall/reapproval, dependencies. |
| P09–P11 | Unrelated changes preserve work; owner changes reject stale replies; active assistant/notification work is not replayed. |
| P12 | Silent renderer recovers after the first-frame deadline; system escape and explicit retry work. Static screens need no heartbeat. |
| P13 | Host restart and full phone reboot preserve settings/grants/order; unavailable-at-start behavior is correct. |
| P14 | Notifications, overlays, Band/Full panel, input and sleep/wake behave correctly on actual glasses. |

The September 9 phone run at `0c12295` recorded 3 passed, 6 partial and 5 not-run
compound cases. It preceded the upstream merge at `efd22f2` and SDK 0.3.0.
Earlier September 8 checks cover additional behavior on older builds. A final
candidate device pass remains required. Do not infer completion from settings
labels, successful frame copying, or old screenshots.

## Release gates

- A clean source revision with passing PR CI, exact baseline failures disclosed.
- Current candidate device evidence covering the matrix above.
- Immutable SDK coordinate and kit, matching source archive, compatible host
  APK, manifest and SHA-256 files from one workflow run.
- Current quickstart, typed event guide and generated field reference; no
  broken local links in the exported kit.
- Maintainer publication of the tested artifacts and a durable download link.

The release-candidate workflow prepares reviewable artifacts. It does not
publish them or mark the physical acceptance checklist complete.
