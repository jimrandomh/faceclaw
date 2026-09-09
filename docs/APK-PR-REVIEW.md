# APK platform reviewer map

This change lets independently installed Android APKs provide glasses windows
and explicitly granted global customizations. The host binds SDK services under
their own Android UIDs. It never loads their code into the host process.

Review the full upstream-to-candidate diff in this order:

| Area | Main entry points | Evidence |
| --- | --- | --- |
| Discovery, approval, IPC and frames | `FaceclawExternalApps.java`, SDK `FaceclawAppService.java`, `PackageIdentity.java`, `ApprovalStore.java` | Native `BoundaryTest`, including nine simultaneous approved fixture services |
| Saved preferences and priority | `FaceclawExtensions.java`, `ExtensionSnapshotBudget.java`, SDK `ExtensionPolicy.java`, `app/ui/extension-settings.ts` | Native snapshot admission tests; extension policy/font/settings regressions |
| Window and provider integration | `app/apps/external/`, `app/ui/shell/` | Surface recovery, lifecycle, gestures and provider regressions |
| Notification and voice authority | Native notification listener, external notification cache, shell voice/review paths | Boundary and host notification/voice tests; uncertain outcomes never imply retry |
| SDK authoring | `HostEvent.java`, `WindowState.java`, `ProviderRequests.java`, `android-sdk/starter/`, `android-sdk/examples/` | SDK unit tests and builds of standalone consumers/examples |
| Distribution and CI | `scripts/audit-apk-platform.sh`, `android-sdk/scripts/`, `.github/workflows/` | Generated contract/tooling checks, local package tests, API 26/35 workflow |

One owner wins each complete feature. Different features may have different
owners. Saved host preferences remain separate from overrides. Live outages use
host fallback without silently selecting another provider for dispatched work.
Static settings may survive process loss; owner changes invalidate authority.

There is no fixed eight-app connection or declaration-owner cap. Approved installed
services retain per-app frame, queue, request and permission bounds. Declaration
admission reserves the worst-case complete snapshot within the existing control
message limit. Oversized declarations leave the previous accepted state intact.
This is not a claim that arbitrary numbers of Android processes run without cost.

Run `scripts/audit-apk-platform.sh --allow-known-upstream-failures`. It stops at a
failed toolchain preflight and retains evidence. The exact eight upstream host
test failures remain disclosed. No additional failures are allowed. PR/main CI
has no path filters, so manifests, dependencies and native build inputs cannot
silently skip verification.

Bundled font notices have only had line endings and trailing whitespace normalized;
their wording is unchanged.
Use `git diff --check origin/main` for the full proposed patch, including working
changes. Consult [acceptance](APK-ACCEPTANCE.md) for device/remote-CI gates and
[distribution](APK-DISTRIBUTION.md) for repository-local artifact preparation.
