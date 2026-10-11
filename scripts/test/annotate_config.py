#!/usr/bin/env python3
"""Annotate a pulled faceclaw_settings.xml with placeholders for unset settings.

Settings that have never been configured are absent from the SharedPreferences
file, which makes it unclear what keys exist or where to add them. This script
scans the app's TypeScript source for ConfigSetting declarations (the settings
catalog) and appends a commented-out XML node for every setting not already
present in the file, so pull_config.sh -> edit -> push_config.sh is a
convenient way to configure things like API keys.

Usage: annotate_config.py [settings-xml] [app-src-dir]
Defaults: faceclaw_settings.xml, <repo>/app (relative to this script).
"""

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def find_setting_blocks(source: str):
    """Yield (kind, block_text) for each `new ConfigSetting*({...})` in source."""
    for match in re.finditer(
        r"new\s+ConfigSetting(Boolean|Enum|String)(?:<[^>(]*>)?\s*\(\s*\{", source
    ):
        kind = match.group(1)
        # Walk to the matching close brace of the options object literal.
        depth = 1
        pos = match.end()
        while pos < len(source) and depth > 0:
            ch = source[pos]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            pos += 1
        yield kind, source[match.end() : pos - 1]


STRING_LITERAL = r'"((?:[^"\\]|\\.)*)"'


def unescape(literal: str) -> str:
    return re.sub(r"\\(.)", r"\1", literal)


def field_string(block: str, name: str):
    m = re.search(rf"{name}:\s*{STRING_LITERAL}", block)
    return unescape(m.group(1)) if m else None


def field_string_or_ident(block: str, name: str):
    """Return ('literal', value) or ('ident', name) or None."""
    m = re.search(rf"{name}:\s*(?:{STRING_LITERAL}|([A-Za-z_][A-Za-z0-9_]*))", block)
    if not m:
        return None
    if m.group(1) is not None:
        return ("literal", unescape(m.group(1)))
    return ("ident", m.group(2))


def parse_string_array(text: str):
    return [unescape(m.group(1)) for m in re.finditer(STRING_LITERAL, text)]


def build_constant_tables(sources):
    """Map identifier -> string value, and identifier -> list of strings."""
    string_consts = {}
    array_consts = {}
    for source in sources:
        for m in re.finditer(
            rf"const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*{STRING_LITERAL}", source
        ):
            string_consts[m.group(1)] = unescape(m.group(2))
        for m in re.finditer(
            r"const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[([^\]]*)\]", source, re.S
        ):
            values = parse_string_array(m.group(2))
            if values:
                array_consts[m.group(1)] = values
    return string_consts, array_consts


def collect_settings(app_dir: Path):
    sources = [p.read_text(encoding="utf-8") for p in sorted(app_dir.rglob("*.ts"))]
    string_consts, array_consts = build_constant_tables(sources)
    settings = []
    for source in sources:
        for kind, block in find_setting_blocks(source):
            key_ref = field_string_or_ident(block, "storageKey")
            if key_ref is None:
                continue
            key = key_ref[1] if key_ref[0] == "literal" else string_consts.get(key_ref[1])
            if key is None:
                print(
                    f"warning: could not resolve storageKey {key_ref[1]}",
                    file=sys.stderr,
                )
                continue

            if kind == "Boolean":
                m = re.search(r"defaultValue:\s*(true|false)", block)
                default = m.group(1) if m else "false"
            else:
                default = field_string(block, "defaultValue") or ""

            values = None
            if kind == "Enum":
                m = re.search(r"values:\s*(?:\[([^\]]*)\]|([A-Za-z_][A-Za-z0-9_]*))", block, re.S)
                if m and m.group(1) is not None:
                    values = parse_string_array(m.group(1))
                elif m:
                    values = array_consts.get(m.group(2))

            settings.append(
                {
                    "key": key,
                    "kind": kind,
                    "default": default,
                    "label": field_string(block, "label"),
                    "description": field_string(block, "description"),
                    "values": values,
                }
            )
    return settings


def xml_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def comment_safe(text: str) -> str:
    # "--" is illegal inside an XML comment.
    return re.sub(r"-{2,}", "-", text)


def placeholder_comment(setting) -> str:
    lines = []
    title = setting["label"] or setting["key"]
    desc = f": {setting['description']}" if setting["description"] else ""
    lines.append(f"{title}{desc}")
    if setting["values"]:
        lines.append(f"Allowed values: {', '.join(setting['values'])}")
    if setting["kind"] == "Boolean":
        node = f'<boolean name="{setting["key"]}" value="{setting["default"]}" />'
    else:
        node = f'<string name="{setting["key"]}">{xml_escape(setting["default"])}</string>'
    lines.append(node)
    body = "\n         ".join(comment_safe(line) for line in lines)
    return f"    <!-- {body} -->"


def main() -> int:
    xml_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("faceclaw_settings.xml")
    app_dir = (
        Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "app"
    )

    content = xml_path.read_text(encoding="utf-8")
    present = {
        child.get("name")
        for child in ET.fromstring(content)
        if child.get("name") is not None
    }

    missing = [s for s in collect_settings(app_dir) if s["key"] not in present]
    if not missing:
        return 0
    missing.sort(key=lambda s: s["key"])

    close_tag = content.rfind("</map>")
    if close_tag < 0:
        print(f"error: no </map> in {xml_path}", file=sys.stderr)
        return 1

    header = (
        "    <!-- Settings below have never been set on the device and show their\n"
        "         default values. To configure one, uncomment its node (keep it\n"
        "         inside <map>), fill in the value, and run scripts/push_config.sh. -->\n"
    )
    block = header + "\n".join(placeholder_comment(s) for s in missing) + "\n"
    xml_path.write_text(content[:close_tag] + block + content[close_tag:], encoding="utf-8")
    print(f"Added placeholders for {len(missing)} unset setting(s) to {xml_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
