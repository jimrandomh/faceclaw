#!/usr/bin/env python3
"""Create a uniquely named, standalone Java APK project from a verified SDK kit."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from xml.sax.saxutils import escape

KEYWORDS = set("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null _".split())


def validate(package, name):
    if (not re.fullmatch(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+", package)
            or len(package) > 150 or any(part in KEYWORDS for part in package.split("."))
            or package == "com.faceclaw" or package.startswith("com.faceclaw.")):
        raise ValueError("use a unique lowercase Java package outside com.faceclaw, for example dev.example.weather")
    if not name.strip() or name != name.strip() or len(name) > 60 or any(ord(c) < 32 for c in name):
        raise ValueError("display name must contain 1–60 printable characters without surrounding whitespace")


def create(kit, destination, package, name):
    validate(package, name)
    kit = kit.resolve()
    if destination.exists() or destination.is_symlink():
        raise ValueError("destination already exists; nothing was overwritten")
    destination = destination.resolve()
    if kit == destination or kit in destination.parents:
        raise ValueError("create the app outside the untouched kit")
    verifier = Path(__file__).with_name("verify-portable-kit.py")
    subprocess.run([sys.executable, str(verifier), str(kit)], check=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.mkdir()
    try:
        shutil.copytree(kit / "starter", destination, dirs_exist_ok=True)
        for folder in ("sdk-repository", "sdk", "docs", "generated", "tools", "licenses"):
            shutil.copytree(kit / folder, destination / folder)
        shutil.copy2(kit / "LICENSE", destination / "LICENSE")
        shutil.copy2(kit / "PORTABLE-KIT.json", destination / "SDK-PROVENANCE.json")
        for source in (destination / "app/src").rglob("*.java"):
            source.write_text(source.read_text().replace("com.faceclaw.starter", package))
        for variant in ("main", "test"):
            old = destination / f"app/src/{variant}/java/com/faceclaw/starter"
            new = destination / f"app/src/{variant}/java" / Path(*package.split("."))
            new.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(old), str(new))
        build = destination / "app/build.gradle.kts"
        build.write_text(build.read_text().replace("com.faceclaw.starter", package))
        settings = destination / "settings.gradle.kts"
        settings.write_text(settings.read_text().replace('"faceclaw-apk-starter"', json.dumps(package)))
        manifest = destination / "app/src/main/AndroidManifest.xml"
        manifest.write_text(re.sub(r'android:label="[^"]*"', 'android:label="@string/app_name"', manifest.read_text()))
        resources = destination / "app/src/main/res/values"
        resources.mkdir(parents=True, exist_ok=True)
        android_name = escape(name.replace("\\", "\\\\").replace("'", "\\'").replace('"', '\\"').replace("@", "\\@").replace("?", "\\?"))
        (resources / "strings.xml").write_text(f'<resources><string name="app_name" formatted="false">{android_name}</string></resources>\n')
        (destination / ".gitignore").write_text(".gradle/\n**/build/\nlocal.properties\n*.jks\n*.keystore\n")
        (destination / "README.md").write_text(
            f"# {name}\n\nAndroid package: `{package}`. Generated from SDK 0.3.0.\n\n"
            "```sh\npython3 tools/doctor.py\n./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug\n```\n\n"
            "Read [AI instructions](AGENTS.md), [SDK events](sdk/EVENTS.md), and [recipes](docs/APK-RECIPES.md). "
            "The local `sdk-repository/` is the only Faceclaw dependency. No host checkout is needed.\n\n"
            "Install `app/build/outputs/apk/debug/app-debug.apk` on a verified development device, then approve "
            "the app in Faceclaw and select the host in the app's consent dialog. Preserve your package ID "
            "and signing key for updates. Keep release signing keys outside this repository.\n\n"
            "`SDK-PROVENANCE.json` identifies the input SDK. It is not a checksum manifest for your edited app.\n")
    except Exception:
        shutil.rmtree(destination)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kit", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--package", required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    try:
        create(args.kit.resolve(), args.destination.absolute(), args.package, args.name)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"app creation failed: {error}", file=sys.stderr)
        return 1
    print(f"Created {args.package} at {args.destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
