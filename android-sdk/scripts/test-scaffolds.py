#!/usr/bin/env python3
"""Build and test two generated apps outside the checkout; retain APKs and evidence."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kit", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    kit, output = args.kit.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    results = []
    with tempfile.TemporaryDirectory(prefix="faceclaw-scaffolds-") as folder:
        for suffix, label in (("alpha", 'Alpha & "Preview"'), ("beta", "Beta's preview")):
            package = "dev.faceclaw.samples." + suffix
            project = Path(folder) / suffix
            subprocess.run([sys.executable, str(kit / "tools/create-app.py"), str(kit), str(project), "--package", package, "--name", label], check=True)
            with (output / (suffix + ".log")).open("w") as log:
                result = subprocess.run([str(project / "gradlew"), ":app:testDebugUnitTest", ":app:assembleDebug", ":app:lintDebug"], cwd=project, stdout=log, stderr=subprocess.STDOUT)
            results.append({"package": package, "status": result.returncode})
            if result.returncode == 0:
                shutil.copy2(project / "app/build/outputs/apk/debug/app-debug.apk", output / (suffix + ".apk"))
            reports = project / "app/build/reports"
            if reports.exists():
                shutil.copytree(reports, output / (suffix + "-reports"))
            shutil.copytree(project / "app/src", output / (suffix + "-source"))
    (output / "summary.json").write_text(json.dumps({"schema": 1, "apps": results}, indent=2) + "\n")
    return 0 if all(result["status"] == 0 for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
