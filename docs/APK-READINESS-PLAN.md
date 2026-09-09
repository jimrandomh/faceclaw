# APK platform readiness implementation

This work addresses the September 9, 2026 readiness audit of `4175ff2` and integrates upstream `57ace70`. Work takes place on `fix/apk-platform-readiness`; the original proposal remains available on `review/apk-app-platform`.

## Scope and acceptance

1. **Reconcile upstream.** Preserve notification source filters in built-in and APK presentation paths, private APK notification boundaries, reply freshness, and wake behavior. Retain upstream compass, phone input/rotation, media filtering and BLE improvements. Repair stale test harnesses without weakening their assertions.
2. **Make settings edits predictable.** Separate saved base values from effective overrides in the font editor. Show the active owner and explain dependency, permission and connection states. Keep whole-feature arbitration explicit and preserve grants/order through changes.
3. **Version the SDK contract.** Keep ordinary protocol-v1 windows compatible. Require explicit negotiation for the revised extension semantics, expose capabilities and incompatibility reasons, and test mixed host/client versions. Supply a pinned portable SDK distribution with generated schemas, typed declarations and reference documentation.
4. **Recover from unavailable renderers.** Require a first frame within a bounded deadline after opening a visible surface. Recover through host-owned UI and an explicit retry, without replaying assistant or tool work. Do not time out unchanged static screens. Cancel requests on deadline and keep app callback failures observable without logging payloads.
5. **Provide a repeatable app-development and audit workflow.** Add a complete standalone starter, phone setup and preview, clear AI contributor instructions, redacted diagnostics, generated contract checks, and CI for host/SDK/examples and emulator boundaries. Move workspace-specific migration history out of the general extension guide.
6. **Re-audit the integrated result.** Run focused regressions, combined host and SDK checks, standalone-consumer build, native boundary and A/B tests. Record evidence against exact commits/builds and distinguish emulator results from physical phone/glasses acceptance.

## Invariants

- External APKs keep their own UID, code, credentials and Android permissions. No dynamic loading into the host.
- Preserve signer/package/UID approval, session and feature authority checks, bounded private frame copies, explicit grants, fresh gestures and reviewed sends.
- APK declarations do not write host base settings, grants or priority. Dependencies and whole-feature priority determine effective settings.
- Unknown dispatched outcomes never authorize automatic retry or provider substitution.
- Diagnostics exclude credentials, notification bodies, prompts, audio, reply tokens and arbitrary IPC payloads. Test-only consent remains inside emulator fixtures.
- Avoid production data changes, credential changes and physical-device installation without a verified target. Physical glasses acceptance cannot be inferred from emulator results.

## Execution and evidence

The initial beta skill required a main-thread fallback when long idle waits conflicted with progress updates. After the user updated the skill, work resumed with two explicit Luna assignments: renderer recovery at xhigh effort and the standalone developer kit at high effort. Astra owns SDK negotiation, settings, integration and final review. The updated skill permits interruptible 50-second waits; no alternate worker model is used.

Progress and final validation are recorded in the companion readiness report. A remote PR or release is outside this implementation step.
