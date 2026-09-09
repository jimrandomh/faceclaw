#!/usr/bin/env bash
set -euo pipefail

sdk_root="$(cd "$(dirname "$0")/.." && pwd)"
destination_input="${1:-$sdk_root/build/portable-kit/faceclaw-sdk-0.3.0}"
mkdir -p "$(dirname "$destination_input")"
destination="$(cd "$(dirname "$destination_input")" && pwd)/$(basename "$destination_input")"

if [[ -e "$destination" || -L "$destination" ]]; then
  printf 'Refusing to overwrite existing portable kit: %s\n' "$destination" >&2
  exit 2
fi

staging="$(mktemp -d "${TMPDIR:-/tmp}/faceclaw-sdk-export.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
repo="$staging/sdk-repository"

cd "$sdk_root"
./gradlew :sdk:assembleRelease :sdk:publishReleasePublicationToPortableRepositoryRepository \
  -PportableRepositoryDir="$repo"
python3 scripts/generate-extension-contract.py --check

mkdir -p "$destination"
rsync -a --exclude 'build' --exclude '.gradle' --exclude 'local.properties' starter/ "$destination/starter/"
cp -a "$repo" "$destination/sdk-repository"
mkdir -p "$destination/licenses/fonts" "$destination/sdk" "$destination/docs" "$destination/generated" "$destination/tools"
cp "$sdk_root/../LICENSE" "$destination/LICENSE"
cp "$sdk_root/README.md" "$sdk_root/WINDOW_MOTION.md" "$sdk_root/EVENTS.md" "$sdk_root/CHANGELOG.md" "$destination/sdk/"
cp -a "$sdk_root/examples" "$destination/sdk/examples"
mkdir -p "$destination/sdk/priority-demo"
cp "$sdk_root/priority-demo/README.md" "$sdk_root/priority-demo/DEVICE-CHECKLIST.md" "$sdk_root/priority-demo/VALIDATION.md" "$destination/sdk/priority-demo/"
rsync -a --include='*/' --include='*.java' --exclude='*' "$sdk_root/priority-demo/src/" "$destination/sdk/priority-demo/src/"
cp "$sdk_root/scripts/PORTABLE-README.md" "$destination/README.md"
cp "$sdk_root/scripts/inspect-apk-diagnostics.py" "$sdk_root/scripts/verify-portable-kit.py" "$destination/tools/"
cp "$sdk_root/scripts/create-app.py" "$sdk_root/scripts/doctor.py" "$sdk_root/scripts/check-doc-links.py" "$destination/tools/"
cp "$sdk_root/../docs/APK-DEVELOPMENT.md" "$sdk_root/../docs/APK-RECIPES.md" "$sdk_root/../docs/APK-ACCEPTANCE.md" "$destination/docs/"
cp "$sdk_root/generated"/* "$destination/generated/"
cp "$sdk_root/sdk/src/main/assets/faceclaw/fonts/OFL-"*.txt "$destination/licenses/fonts/"
python3 - "$destination" "$sdk_root/.." <<'PY'
import hashlib
import json
import pathlib
import sys
import subprocess

destination = pathlib.Path(sys.argv[1])
source = pathlib.Path(sys.argv[2]).resolve()
revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
dirty = bool(subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True))
paths = subprocess.check_output(["git", "-C", str(source), "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).decode().split("\0")
tree = hashlib.sha256()
for name in sorted(set(filter(None, paths))):
    path = source / name
    tree.update(name.encode() + b"\0")
    tree.update(hashlib.sha256(path.read_bytes()).digest() if path.is_file() else b"missing")
for document in (destination / "docs").glob("*.md"):
    document.write_text(document.read_text().replace("../android-sdk/", "../sdk/"))
# Reference files live beside sdk/, both in the kit and in scaffolded projects.
guide = destination / "sdk/README.md"
guide.write_text(guide.read_text().replace("(generated/", "(../generated/"))
repo = destination / "sdk-repository"
metadata = {"schema": 1, "coordinate": "com.faceclaw:sdk:0.3.0", "starter": "starter",
            "repository": "sdk-repository", "checksums": "SHA256SUMS.json",
            "sourceRevision": revision, "sourceDirty": dirty, "sourceTreeSha256": tree.hexdigest(),
            "protocol": 1, "extensionSemantics": 2,
            "compatibility": "Ordinary protocol-1 windows; global providers require extension semantics 2.",
            "build": "cd starter && ./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug"}
(destination / "PORTABLE-KIT.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
excluded = {destination / "SHA256SUMS.json", destination / "SHA256SUMS.txt"}
files = sorted(path for path in destination.rglob("*") if path.is_file() and path not in excluded)
if not files:
    raise SystemExit("portable Maven repository is empty")
coordinate = repo / "com/faceclaw/sdk/0.3.0/sdk-0.3.0.pom"
if not coordinate.is_file():
    raise SystemExit(f"missing release coordinate: {coordinate}")
entries = []
for path in files:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    entries.append({"path": path.relative_to(destination).as_posix(), "sha256": digest, "bytes": path.stat().st_size})
(destination / "SHA256SUMS.json").write_text(json.dumps({
    "schema": 1,
    "coordinate": "com.faceclaw:sdk:0.3.0",
    "files": entries,
}, indent=2) + "\n", encoding="utf-8")
(destination / "SHA256SUMS.txt").write_text("".join(f"{entry['sha256']}  {entry['path']}\n" for entry in entries), encoding="utf-8")

PY

python3 "$sdk_root/scripts/check-doc-links.py" "$destination"

printf 'Portable kit exported to %s\n' "$destination"
printf 'Build from a copy with: %s\n' "cd $destination/starter && ./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug"
