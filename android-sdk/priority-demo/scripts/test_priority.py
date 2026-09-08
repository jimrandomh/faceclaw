#!/usr/bin/env python3
"""Build and exercise two real demo APKs against the disposable native host.

Refuses physical devices. Test-only instrumentation provides synthetic consent;
the ordinary demo APKs contain no approval bypass or configuration endpoint.
"""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    sdk = Path(__file__).resolve().parents[2]
    output = args.output or Path(tempfile.mkdtemp(prefix="faceclaw-priority-"))
    output.mkdir(parents=True, exist_ok=True)
    adb = shutil.which("adb")
    if not adb:
        adb = str(Path(os.environ.get("ANDROID_HOME", Path.home() / "Library/Android/sdk")) / "platform-tools/adb")
    target = [adb, "-s", args.serial]
    emulator = subprocess.check_output(target + ["shell", "getprop", "ro.kernel.qemu"], text=True).strip()
    if emulator != "1":
        parser.error("This automated suite is emulator-only. Use the manual device checklist for a phone.")

    def run(label, command, success=None):
        print(label, flush=True)
        result = subprocess.run(command, cwd=sdk, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (output / f"{label}.log").write_text(result.stdout)
        if result.returncode or (success and not re.search(success, result.stdout)):
            raise RuntimeError(f"{label} failed; inspect {output / (label + '.log')}\n{result.stdout[-2500:]}")
        return result.stdout

    if not args.skip_build:
        run("build", [str(sdk / "gradlew"), ":sdk:testDebugUnitTest", ":fixture:assembleDebug",
                      ":host-tests:assembleStandaloneDebug", ":host-tests:assembleStandaloneDebugAndroidTest",
                      ":priority-demo:assembleAlphaDebug", ":priority-demo:assembleBetaDebug",
                      ":priority-demo:assembleAlphaDebugAndroidTest", ":priority-demo:assembleBetaDebugAndroidTest"])
    artifacts = ["fixture/build/outputs/apk/debug/fixture-debug.apk",
                 "host-tests/build/outputs/apk/standalone/debug/host-tests-standalone-debug.apk",
                 "host-tests/build/outputs/apk/androidTest/standalone/debug/host-tests-standalone-debug-androidTest.apk"]
    for flavor in ("alpha", "beta"):
        artifacts += [f"priority-demo/build/outputs/apk/{flavor}/debug/priority-demo-{flavor}-debug.apk",
                      f"priority-demo/build/outputs/apk/androidTest/{flavor}/debug/priority-demo-{flavor}-debug-androidTest.apk"]
    for artifact in artifacts:
        run("install-" + Path(artifact).stem, target + ["install", "-r", str(sdk / artifact)], r"Success")

    runner = "com.faceclaw.sdk.hosttest.test/com.faceclaw.sdk.hosttest.BoundaryTest"
    run("native-boundaries", target + ["shell", "am", "instrument", "-w", runner], r"Passed: [1-9]\d* Failed: 0")

    def prepare(variant, mode):
        run(f"prepare-{variant}-{mode}", target + ["shell", "am", "instrument", "-w", "-e", "mode", mode,
            f"com.faceclaw.demo.{variant}.test/com.faceclaw.demo.DemoSetup"], r"Prepared com\.faceclaw\.demo\.")

    prepare("a", "normal")
    prepare("b", "normal")
    cases = ["testDemoIndependentPrioritiesAndOfflineRevocation",
             "testDemoLowerPriorityChangesPreserveWinnerRequestsAndFrames",
             "testDemoFeatureGrantsAreIndependentAndReconnectKeepsOrder",
             "testDemoLauncherInputSuppliesBoundedActionIdentity",
             "testDemoAppSideDisableAndWithdrawalReachTheHost",
             "testDemoDependencyControlsEligibilityAndOfflineAvailability"]
    for case in cases:
        run(case, target + ["shell", "am", "instrument", "-w", "-e", "demos", "true", "-e", "only", case, runner], r"Passed: 1 Failed: 0")
    prepare("a", "late")
    run("testDemoLateReplyCannotCrossOwnerChange", target + ["shell", "am", "instrument", "-w", "-e", "demos", "true", "-e", "only",
        "testDemoLateReplyCannotCrossOwnerChange", runner], r"Passed: 1 Failed: 0")
    prepare("a", "normal")
    print(f"PASS: native boundaries and seven independent-APK scenarios. Evidence: {output}", flush=True)


if __name__ == "__main__":
    main()
