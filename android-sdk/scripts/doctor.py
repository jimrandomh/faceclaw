#!/usr/bin/env python3
"""Check the pinned Faceclaw Android toolchain without installing or changing anything."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def java_version(executable):
    try:
        result = subprocess.run([str(executable), "-version"], capture_output=True, text=True, timeout=15)
        match = re.search(r'(?:version\s+"|javac\s+)(\d+)', result.stdout + result.stderr)
        return int(match.group(1)) if result.returncode == 0 and match else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def inspect(environment):
    java_home = environment.get("JAVA_HOME")
    java = Path(java_home) / "bin/java" if java_home else shutil.which("java", path=environment.get("PATH"))
    javac = Path(java_home) / "bin/javac" if java_home else shutil.which("javac", path=environment.get("PATH"))
    checks = []
    for name, path in (("java", java), ("javac", javac)):
        version = java_version(path) if path else None
        checks.append({"check": name, "ok": version == 21, "version": version, "fix": "Set JAVA_HOME and PATH to JDK 21."})
    if java_home:
        for name in ("java", "javac"):
            path = shutil.which(name, path=environment.get("PATH", ""))
            version = java_version(path) if path else None
            checks.append({"check": name + " on PATH", "ok": version == 21, "version": version,
                           "fix": "Put the JDK 21 bin directory first on PATH; host tests invoke Java from PATH."})
    sdk_value = environment.get("ANDROID_HOME") or environment.get("ANDROID_SDK_ROOT")
    sdk = Path(sdk_value) if sdk_value else None
    for name, relative in (("Android SDK 35", "platforms/android-35/android.jar"),
                           ("build tools 35.0.0", "build-tools/35.0.0/aapt2"), ("adb", "platform-tools/adb"),
                           ("sdkmanager", "cmdline-tools/latest/bin/sdkmanager")):
        checks.append({"check": name, "ok": sdk is not None and (sdk / relative).is_file(),
                       "fix": "Set ANDROID_HOME to an SDK with platform-tools, cmdline-tools, platforms;android-35 and build-tools;35.0.0."})
    return checks


def setup_commands():
    return [
        '# Set these to your installed JDK 21 and Android SDK directories:',
        'export JAVA_HOME="/absolute/path/to/jdk-21"',
        'export ANDROID_HOME="/absolute/path/to/android-sdk"',
        'export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"',
        'sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"',
        'python3 tools/doctor.py  # generated app; in the host use android-sdk/scripts/doctor.py',
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kit", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    checks = inspect(os.environ)
    if args.kit:
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("verify-portable-kit.py")), str(args.kit)], capture_output=True)
        checks.append({"check": "kit integrity", "ok": result.returncode == 0, "fix": "Use an untouched SDK kit and verify it before scaffolding."})
    if args.json:
        print(json.dumps({"schema": 1, "ok": all(c["ok"] for c in checks), "checks": checks, "setupCommands": setup_commands() if not all(c["ok"] for c in checks) else []}, indent=2))
    else:
        for check in checks:
            print(f"{'OK' if check['ok'] else 'FAIL'} {check['check']}" + ("" if check["ok"] else f": {check['fix']}"))
    return 0 if all(check["ok"] for check in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
