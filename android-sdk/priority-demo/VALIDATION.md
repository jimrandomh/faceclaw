# Historical priority demo validation

This report is preserved for the tested September 8 revisions. SDK negotiation
and renderer recovery were implemented afterward. Use the [current acceptance
ledger](../../docs/APK-ACCEPTANCE.md) for current gates.

Recorded September 8, 2026. These results support a draft upstream review. They do not close all release acceptance items in [DEVICE-CHECKLIST.md](DEVICE-CHECKLIST.md).

## Automated checks

| Check | Result |
| --- | --- |
| Native host/SDK boundaries | 38 passed on an Android emulator, including offline revocation and unrelated refresh regressions. |
| Separate Demo A/B APK scenarios | 7 passed after the example polish. Real Messenger connections and separate Android UIDs; synthetic consent exists only in the separate instrumentation APK. |
| SDK unit tests | 15 passed. |
| Demo builds and lint | Both debug and release variants built. Both debug lint tasks passed with the existing SDK 35 `OldTargetApi` warning. |
| Host TypeScript suite before upstream update | 354/357 passed. |
| Host suite combined with upstream `070c891` | 366/369 passed; includes the new upstream Nightscout and Terminal tests. |
| Host Android build | Passed with upstream `070c891` integrated. |
| JavaScript motion helpers | 6/6 tests passed. |
| Host TypeScript typecheck | Passed before and after upstream integration. |
| Standalone T3 | Typecheck and 175/175 tests passed. |

The three host failures are the independently reproduced upstream baseline: temple provenance in `touch-input.test.cjs`, pinball contact/hold/release, and pinball contact cleanup. No new failure remains in the combined test run. The upstream Terminal harness was adapted to provide the extension-platform import and call the activity supplier used by the real icon renderer.

## Physical phone and glasses

The core testing round used a Samsung SM-F966U on Android 16 with a connected G2. It preceded the example-only UI polish and the integration of upstream `070c891`. The polished controls were subsequently checked on the emulator; the polished APKs were not reinstalled on the phone.

Verified through effective-state records, content-free demo logs and the phone mirror:

- A/B typography priority, independent mixed feature winners, withdrawal/republish, and T3 typography restoration. The wearer directly confirmed that changing B14 to A18 enlarged the text in the glasses.
- Editing the host baseline under B preserved the active override; disabling B exposed the edited baseline. This is the P02 variant; the base edit occurred under B rather than A.
- Process outage preserved independent static settings and retained the selected live owner while host behavior appeared. Reconnect restored the live surface. Offline approval revocation immediately released A's cached overrides to B.
- Same-owner dependencies changed eligibility and live availability. T3 served as the alternative launcher owner in the P08 variant.
- A delayed request survived an unrelated B outage. A late response was rejected after disabling A's assistant declaration selected B; B received no automatic replay. A new explicit B request succeeded. This is the P10 variant, using declaration disable rather than priority reorder.
- Silent-provider cancellation reached the provider. A silent renderer remained blank, but the host System actions gesture was accessible.
- Android disable/enable retained B's grants/order; uninstall yielded to T3; reinstall required fresh approval. The new approval prompt was cancelled. A supplied the separate withdrawal/republish check.
- Explicit host restart preserved feature state and host settings and rebuilt the B launcher. Full panel/Band, basic wake/sleep, switcher and system escape were exercised.

After testing, original T3 grants and recorded priority lists were restored, as were the host's Roboto Light 14 baseline and Full panel setting. Screen timeout remained Never by request. Both demo APKs were then uninstalled; the host and T3 remained installed with their data.

## Remaining release acceptance

- Finalize SDK version/capability negotiation before independently distributed host/client releases. Preview `0.1.0` and `extensions: 1` do not identify the per-feature epoch revision.
- Decide and test renderer health behavior. A connected provider that stops delivering frames stays selected/available and can leave a blank surface; no automatic frame-health fallback was observed.
- Complete controlled T3 notification/assistant ownership changes during active synthetic work (P11).
- Complete full phone reboot and unavailable-at-start variants (P13). The completed restart test covered the host process with available providers.
- Complete the broader notification, overlay, input and wake matrix (P14). Measure full silent-provider deadlines and record glasses firmware. Apart from the font confirmation, visual evidence is from the phone mirror.

The selected phone evidence is maintained outside source. Private preferences, raw UI dumps, credentials and notification-interrupted screenshots are not part of the PR materials.
