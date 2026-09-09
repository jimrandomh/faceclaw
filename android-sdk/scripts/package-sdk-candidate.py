#!/usr/bin/env python3
"""Package a verified SDK, host APK and matching source locally; never upload or publish."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args]).decode()


def source_state(repo):
    paths = sorted(set(filter(None, git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0"))))
    digest = hashlib.sha256()
    for name in paths:
        path = repo / name
        digest.update(name.encode() + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest() if path.is_file() else b"missing")
    return paths, digest.hexdigest()


def package(repo, audit, host_apk, output, allow_dirty=False):
    repo, audit, host_apk, output = (Path(p).resolve() for p in (repo, audit, host_apk, output))
    if output.exists():
        raise ValueError("destination exists; nothing was overwritten")
    kit = audit / "portable-kit"
    subprocess.run([sys.executable, str(repo / "android-sdk/scripts/verify-portable-kit.py"), str(kit)], check=True)
    metadata = json.loads((kit / "PORTABLE-KIT.json").read_text())
    result = json.loads((audit / "audit.json").read_text())
    revision = git(repo, "rev-parse", "HEAD").strip()
    dirty = bool(git(repo, "status", "--porcelain"))
    paths, digest = source_state(repo)
    if result.get("failures") != 0 or result.get("revision") != revision:
        raise ValueError("a successful audit of the current revision is required")
    if metadata.get("sourceRevision") != revision or metadata.get("sourceTreeSha256") != digest or metadata.get("sourceDirty") != dirty:
        raise ValueError("source changed since export; rerun the audit")
    if dirty and not allow_dirty:
        raise ValueError("clean source required; --allow-dirty creates local review artifacts only")
    if not host_apk.is_file():
        raise ValueError("host APK does not exist; build the compatible host first")
    version = metadata["coordinate"].rsplit(":", 1)[1]
    if not version or any(c not in "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-" for c in version):
        raise ValueError("invalid SDK version")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".sdk-candidate-", dir=output.parent) as folder:
        staged = Path(folder) / "candidate"
        staged.mkdir()
        with tarfile.open(staged / f"faceclaw-sdk-{version}.tar.gz", "w:gz") as archive:
            archive.add(kit, arcname=f"faceclaw-sdk-{version}")
        # Include the actual audited files, including uncommitted files in local-review mode.
        with tarfile.open(staged / "faceclaw-source.tar.gz", "w:gz") as archive:
            for name in paths:
                if (repo / name).is_file():
                    archive.add(repo / name, arcname=name, recursive=False)
        shutil.copy2(host_apk, staged / "faceclaw-host-debug.apk")
        shutil.copy2(kit / "PORTABLE-KIT.json", staged / "PORTABLE-KIT.json")
        shutil.copy2(audit / "audit.json", staged / "audit.json")
        (staged / "CANDIDATE.json").write_text(json.dumps({
            "schema": 1, "coordinate": metadata["coordinate"], "sourceRevision": revision,
            "sourceTreeSha256": digest, "localReviewOnly": dirty,
            "physicalAcceptance": "not-certified-by-packaging",
            "hostApkSha256": hashlib.sha256(host_apk.read_bytes()).hexdigest(),
        }, indent=2) + "\n")
        (staged / "SHA256SUMS.txt").write_text("".join(
            f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in sorted(staged.iterdir())))
        # Detect source edits during packaging rather than shipping inconsistent provenance.
        if source_state(repo)[1] != digest:
            raise ValueError("source changed during packaging; retry after finishing edits")
        staged.rename(output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", required=True, type=Path)
    parser.add_argument("--host-apk", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path("dist/sdk-candidate"))
    parser.add_argument("--allow-dirty", action="store_true", help="local review only, with exact working source")
    args = parser.parse_args()
    try:
        output = package(Path(__file__).resolve().parents[2], args.audit, args.host_apk, args.output, args.allow_dirty)
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(f"SDK packaging failed: {error}", file=sys.stderr)
        return 1
    print(f"SDK candidate prepared locally: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
