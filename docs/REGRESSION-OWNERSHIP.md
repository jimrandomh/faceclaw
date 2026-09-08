# Extraction regression ownership

The original T3 fork's host regressions remain executable in the generic host. No T3 implementation was imported to satisfy these tests. This maps the thirteen exclusions listed in the standalone APK's `EXTRACTION.md`.

| Original regression | Current executable owner |
| --- | --- |
| Full-shell reviewed voice after microphone permission | `tests/host-voice-notification-security.test.cjs`: notification reply full-shell lifecycle |
| Notification disappears during permission prompt | Same file: disappearing notification prevents capture/send |
| Review cleanup during sleep cannot wake display | Same file: sleep cleanup |
| Explicitly authorized background app launch preserves ordinary proactive gate | `tests/extension-own-notifications.test.cjs`: explicit device-tool grant preserves ordinary proactive and availability gates; T3 project provenance remains APK-owned |
| T3 project/replay/six-call background relay gates | APK `tests/t3-security.test.cjs`: wrong project/expiry/duplicate and provider provenance; APK `tests/extension-boundaries.test.cjs`: pure six-call limit plus complete adapted relay test rejects wrong project/duplicate and permits exactly six of seven valid calls before host dispatch |
| Native removal callback requires generated proxy override | `tests/host-voice-notification-security.test.cjs`: native removal contract |
| Native snapshot changes invalidate icons without fake arrival | Same file: snapshot invalidation/observer fanout |
| Native replies check access/freshness/creator/duplicates | Same file: native reply guards and consume-before-send ordering |
| Phone removal invalidates cache and reaches every observer | Same file: phone removal |
| APK review cancellation beneath newer overlay cannot send | Same file: cancellation under newer overlay |
| APK search has only Search callback and rechecks permission | Same file: search authority after permission |
| APK search cancellation blocks late query/send | Same file: late search cancellation |
| Input dialog fills configured viewport | `tests/extension-input-layout.test.cjs` |

`tests/extension-policy.test.cjs` separately verifies host owner-bound tool replay/expiry and versioned notification leases. The native cross-UID `BoundaryTest` verifies signing/session/UID ownership, grant and visibility checks, private frame copying, reply replay rejection, and ambiguous IPC outcomes. Its extension-surface case also checks pointer coordinates against the exact current visible viewport.

The bridge retains server-side project scope checks in `../faceclaw-t3-bridge/bridge/test/security.test.ts`, including rejected missing/archived/deleted-project sessions and project allowlisting on new-session routes. The APK's six-call proactive policy is enforced before host dispatch; the generic host keeps its own independent feature grant, availability and replay checks. Bridge tests were inspected for this mapping; this host-only regression pass did not rerun the bridge suite.
