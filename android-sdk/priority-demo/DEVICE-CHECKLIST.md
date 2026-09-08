# Phone and glasses acceptance record

This is a reusable checklist; Pending cells are blanks for a new run. See [VALIDATION.md](VALIDATION.md) for the recorded September 8, 2026 results. Expand **Advanced testing** in either demo for dependency, withdrawal and failure probes.

Status: pending physical-device testing. Run after wireless debugging is enabled and the phone serial and active host package have been verified. Automated emulator evidence is separate.

Record date, phone model/Android version, glasses firmware, selected host package/version, T3 version and the SHA-256 of each installed APK. Preserve the phone's app data and existing signing identities. Install the ordinary A/B demo APKs and matching host/T3 builds only. Do not install `host-tests`, `fixture`, or demo `androidTest` APKs on the phone.

## Setup

- [ ] Identify the active host. The generic build is `com.faceclaw.app`; the old integrated fork is a different package. Verify compatibility before updating.
- [ ] Install A and B; verify separate icons/settings and mutual host consent for each.
- [ ] Record the initial grants, per-feature order and host baseline font/layout settings.
- [ ] Start with typography only. Grant B, then A, and place A above B. Leave T3's unrelated features as recorded.
- [ ] Confirm a demo's glass window and a built-in host window both show the effective shared typography.

## Acceptance cases

Record observed owner/availability, per-feature epoch and a screenshot or short observation for each case. Do not mark a case passed from settings labels alone.

| ID | Steps | Expected visible behavior | Result / evidence |
| --- | --- | --- | --- |
| P01 | Enable B, then A above B. Disable A typography. | B's 14 px Roboto replaces A's 18 px Inter. Other feature winners remain unchanged. | Pending |
| P02 | Re-enable A. Edit the host's base font while A overrides it. Disable A, then B. | A remains effective during the base edit; B appears next; removing both reveals the newly edited base. | Pending |
| P03 | Put A above B for typography and B above A for navigation/layout. | Mixed winners apply together; gesture mapping matches the selected navigation provider. | Pending |
| P04 | Put T3 above B for the same features, then disable the corresponding T3 declarations. | B becomes effective for those features. Re-enable T3 to restore the higher selection. | Pending |
| P05 | Crash A while it owns independent static settings and a live feature. | Static A settings persist; live A selection remains but host behavior is used during outage. B is not automatically promoted. Reconnect restores A. | Pending |
| P06 | Make A unavailable; revoke its full host approval while offline. | A's effective overrides disappear immediately and B takes over eligible features. | Pending |
| P07 | Withdraw A's declarations, republish, then disable/uninstall A. | Withdrawal/disable/uninstall exposes B. Republish preserves existing grants/order where applicable; reinstall after uninstall requires fresh approval. | Pending |
| P08 | A typography requires A launcher. Give B launcher priority, then A. Stop A's service. | B typography wins while the dependency is ineligible; A wins both when eligible; offline live dependency causes host typography fallback without promoting B. | Pending |
| P09 | Start A's delayed synthetic response. Change B's unrelated settings or crash B. | A completes once; its feature epoch and active surface remain stable. | Pending |
| P10 | Start A's late-response probe; move B above A before it returns. | Old A text/actions are not admitted. There is no automatic resend. A new explicit B request works. | Pending |
| P11 | Switch real T3 notification/assistant ownership during active work using synthetic content. | Stale frames/replies are rejected; no duplicate send or unreviewed action occurs. An uncertain dispatched operation stays uncertain. | Pending |
| P12 | Test a silent renderer/provider, then cancel or use the reserved system escape gesture. | Host remains recoverable. Record any missing timeout/fallback behavior as an issue; a connected process is not proof of responsiveness. | Pending |
| P13 | Restart the host and phone with A selected, first available and then unavailable. | User order, grants and baseline preferences persist; live/static outage policy remains consistent. | Pending |
| P14 | Exercise notifications, app switcher, full/compact layouts and wake/sleep while changing providers. | No stale overlay, hidden input target, unintended wake, duplicate arrival or lost system escape. | Pending |

## Finish

- [ ] Restore the recorded host preferences, desired T3 priority and grants. Disable or revoke demo overrides.
- [ ] Record any unresolved device/OEM/background, renderer timeout or Bluetooth performance issues.
- [ ] Attach this completed record and emulator results to the proposed upstream changes.

The repository still has three independently reproduced upstream touch/pinball test failures. Keep that baseline visible in the PR checks; it is not part of this demo implementation's pass claim.
