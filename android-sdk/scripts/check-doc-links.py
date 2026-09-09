#!/usr/bin/env python3
"""Check local Markdown file links in the shipped developer kit (offline)."""
import argparse
from pathlib import Path
import re
from urllib.parse import unquote


def broken_links(root):
    broken = []
    for source in root.rglob("*.md"):
        for target in re.findall(r"\]\(([^)]+)\)", source.read_text(encoding="utf-8")):
            target = target.strip().strip("<>")
            if target.startswith("#") or re.match(r"[a-zA-Z]+:", target):
                continue
            path = unquote(target.split("#", 1)[0])
            if path and not (source.parent / path).exists():
                broken.append(f"{source.relative_to(root)} -> {target}")
    return broken


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    if not args.root.is_dir():
        parser.error("root must be a directory")
    broken = broken_links(args.root)
    for line in broken:
        print(line)
    print(f"{len(broken)} broken local Markdown links")
    return 1 if broken else 0


if __name__ == "__main__":
    raise SystemExit(main())
