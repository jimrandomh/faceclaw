#!/usr/bin/env python3
"""Verify every SDK repository file listed by a portable kit's SHA manifest."""
from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: verify-portable-kit.py KIT", file=sys.stderr)
        return 2
    root = pathlib.Path(sys.argv[1]).resolve()
    try:
        manifest = json.loads((root / "SHA256SUMS.json").read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or type(manifest.get("schema")) is not int or manifest.get("schema") != 1 or manifest.get("coordinate") != "com.faceclaw:sdk:0.3.0":
            raise ValueError("unsupported SHA manifest")
        entries = manifest.get("files")
        if not isinstance(entries, list) or not entries:
            raise ValueError("empty SHA manifest")
        excluded = {root / "SHA256SUMS.json", root / "SHA256SUMS.txt"}
        if any(path.is_symlink() for path in root.rglob("*")):
            raise ValueError("symlinks are not kit files")
        listed = set()
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "bytes"}:
                raise ValueError("invalid SHA manifest entry")
            if not isinstance(entry["path"], str) or not entry["path"]:
                raise ValueError("invalid manifest path")
            relative = pathlib.PurePosixPath(entry["path"])
            if relative.is_absolute() or ".." in relative.parts or relative.as_posix() != entry["path"]:
                raise ValueError(f"unsafe manifest path: {relative}")
            if type(entry["bytes"]) is not int or entry["bytes"] < 0 or not isinstance(entry["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
                raise ValueError("invalid manifest digest or size")
            if relative.as_posix() in listed:
                raise ValueError("duplicate SHA manifest entry")
            listed.add(relative.as_posix())
            path = (root / pathlib.Path(*relative.parts)).resolve()
            if root not in path.parents or not path.is_file():
                raise ValueError(f"missing manifest file: {relative}")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != entry.get("sha256") or path.stat().st_size != entry.get("bytes"):
                raise ValueError(f"checksum mismatch: {relative}")
        actual = {
            path.relative_to(root).as_posix()
            for path in root.rglob("*")
            if path.is_file() and path not in excluded
        }
        if actual != listed:
            raise ValueError("SHA manifest does not cover the kit files exactly")
        expected_text = "".join(f"{entry['sha256']}  {entry['path']}\n" for entry in entries)
        if (root / "SHA256SUMS.txt").read_text(encoding="utf-8") != expected_text:
            raise ValueError("checksum manifests disagree")
        print(f"verified {len(entries)} files for {manifest['coordinate']}")
        return 0
    except (OSError, KeyError, TypeError, ValueError, RecursionError):
        print("invalid portable kit", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
