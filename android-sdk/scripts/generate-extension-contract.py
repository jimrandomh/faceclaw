#!/usr/bin/env python3
"""Generate extension contract artifacts from the SDK's canonical Java contract.

The parser is deliberately small and strict. A contract source edit that uses a
new rule form must update this generator rather than silently producing stale
consumer types.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "sdk/src/main/java/com/faceclaw/sdk/ExtensionContract.java"
OUT = ROOT / "generated"
REQUIRED_DEDICATED_FEATURES = {
    "ui.launcher", "ui.navigation", "ui.window-layout", "ui.typography", "ui.app-menu",
}

FEATURE_LIST_RE = re.compile(r"FEATURES\s*=.*?Arrays\.asList\((.*?)\)", re.S)
FEATURE_RE = re.compile(r'feature\.equals\("([^"\\]+)"\)')
RULE_RE = re.compile(r'rules\.put\("([^"\\]+)","((?:\\\\.|[^"\\])*)"\)')
QUOTED_RE = re.compile(r'"([^"\\]*(?:\\.[^"\\]*)*)"')


def fail(message: str) -> "NoReturn":
    raise ValueError(message)


def quoted_values(text: str) -> list[str]:
    return [bytes(value, "utf-8").decode("unicode_escape") for value in QUOTED_RE.findall(text)]


def matching_block(source: str, start: int) -> str:
    opening = source.find("{", start)
    if opening < 0:
        fail("configuration rule block has no opening brace")
    depth = 0
    in_string = False
    escaped = False
    for index in range(opening, len(source)):
        char = source[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[opening + 1:index]
    fail("unterminated configuration rule block")


def parse(source: str) -> tuple[list[str], dict[str, dict[str, str]]]:
    if "public static JSONObject configuration(String feature,JSONObject data)" not in source:
        fail("canonical feature configuration method is missing")
    feature_match = FEATURE_LIST_RE.search(source)
    if not feature_match:
        fail("canonical FEATURES list is missing")
    features = quoted_values(feature_match.group(1))
    if not features or len(set(features)) != len(features):
        fail("FEATURES must be a non-empty list of unique string tokens")
    rules: dict[str, dict[str, str]] = {}
    seen_blocks: set[str] = set()
    config_start = source.index("Map<String,String> rules=new HashMap<>();", source.index("configuration(String feature"))
    config_end = source.index("for(Iterator<String> keys=data.keys();", config_start)
    rule_source = source[config_start:config_end]
    branch_re = re.compile(r'(?:if|else if)\(feature\.equals\("([^"\\]+)"\)\)\s*\{([^}]*)\}')
    for match in branch_re.finditer(rule_source):
        feature = match.group(1)
        if feature in seen_blocks:
            fail(f"duplicate feature rule block: {feature}")
        seen_blocks.add(feature)
        if feature not in features:
            fail(f"rule block names unknown feature: {feature}")
        block = match.group(2)
        matches = list(RULE_RE.finditer(block))
        if block.count("rules.put(") != len(matches):
            fail(f"unsupported rules.put syntax in feature: {feature}")
        parsed = {item.group(1): bytes(item.group(2), "utf-8").decode("unicode_escape") for item in matches}
        if len(parsed) != len(matches):
            fail(f"duplicate configuration key in feature: {feature}")
        rules[feature] = parsed

    # The final else branch is the canonical rule for every feature without a
    # dedicated block. Keep this exact form so new syntax cannot be ignored.
    generic = re.search(r"}\s*else\s+rules\.put\(\"([^\"]+)\",\"([^\"]+)\"\);", source)
    if not generic:
        fail("generic feature rule branch is missing or changed")
    generic_rule = {generic.group(1): generic.group(2)}
    if seen_blocks != REQUIRED_DEDICATED_FEATURES:
        fail("dedicated feature rule branches changed or are incomplete")
    for feature in features:
        rules.setdefault(feature, dict(generic_rule))
    if set(rules) != set(features):
        fail("feature rule coverage does not match FEATURES")
    allowed = {"boolean", "text"}
    for feature, feature_rules in rules.items():
        for key, rule in feature_rules.items():
            if rule in allowed or re.fullmatch(r"\d+:\d+", rule) or "|" in rule or rule.startswith("(?:"):
                continue
            fail(f"unsupported configuration rule {feature}.{key}: {rule}")
    return features, rules


def property_schema(rule: str) -> dict:
    if rule == "boolean":
        return {"type": "boolean"}
    if rule == "text":
        return {"type": "string", "maxLength": 100, "pattern": r"^[^\x00-\x1f\x7f]*$"}
    bounds = re.fullmatch(r"(\d+):(\d+)", rule)
    if bounds:
        return {"type": "integer", "minimum": int(bounds.group(1)), "maximum": int(bounds.group(2))}
    if rule.startswith("(?:"):
        return {"type": "string", "pattern": f"^{rule}$"}
    return {"type": "string", "enum": rule.split("|")}


def config_schema(rules: dict[str, str]) -> dict:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {key: property_schema(value) for key, value in rules.items()},
    }


def generate_schema(features: list[str], rules: dict[str, dict[str, str]]) -> str:
    declarations = []
    for feature in features:
        declarations.append({
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "feature": {"const": feature},
                "enabled": {"type": "boolean"},
                "configuration": config_schema(rules[feature]),
                "requires": {"type": "array", "uniqueItems": True, "maxItems": len(features), "items": {"enum": features}},
            },
            "required": ["feature", "enabled", "configuration"],
        })
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://faceclaw.dev/schemas/extension-contract-1.json",
        "title": "Faceclaw APK extension declarations",
        "description": "Generated from sdk/src/main/java/com/faceclaw/sdk/ExtensionContract.java.",
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "declarations": {
                "type": "array",
                "maxItems": len(features),
                "uniqueItems": True,
                "items": {"oneOf": declarations},
            }
        },
        "required": ["declarations"],
    }
    return json.dumps(schema, indent=2, sort_keys=False) + "\n"


def ts_type(rule: str) -> str:
    if rule == "boolean":
        return "boolean"
    if rule == "text":
        return "string"
    if re.fullmatch(r"\d+:\d+", rule) or rule.startswith("(?:"):
        return "number" if re.fullmatch(r"\d+:\d+", rule) else "string"
    return " | ".join(json.dumps(value) for value in rule.split("|"))


def generate_types(features: list[str], rules: dict[str, dict[str, str]]) -> str:
    lines = [
        "// Generated by scripts/generate-extension-contract.py; do not edit.",
        "",
        "export type ExtensionFeature = " + " | ".join(json.dumps(value) for value in features) + ";",
        "",
        "export interface ExtensionConfigurationMap {",
    ]
    for feature in features:
        lines.append(f"  {json.dumps(feature)}: {{")
        for key, rule in rules[feature].items():
            lines.append(f"    {key}?: {ts_type(rule)};")
        lines.append("  };")
    lines += [
        "}",
        "",
        "export type ExtensionConfiguration = ExtensionConfigurationMap[ExtensionFeature];",
        "",
        "export type ExtensionDeclarationFor<F extends ExtensionFeature> = F extends ExtensionFeature ? {",
        "  feature: F;",
        "  enabled: boolean;",
        "  configuration: ExtensionConfigurationMap[F];",
        "  requires?: readonly ExtensionFeature[];",
        "} : never;",
        "",
        "export type ExtensionDeclaration<F extends ExtensionFeature = ExtensionFeature> = ExtensionDeclarationFor<F>;",
        "",
        "export type ExtensionDeclarations = readonly ExtensionDeclaration[];",
        "",
    ]
    return "\n".join(lines)


def generate_type_fixture() -> str:
    return """// Generated type contract checks; expected errors prove feature/config discrimination.
import type { ExtensionDeclaration } from \"./extension-contract\";

const valid: ExtensionDeclaration = {
  feature: \"ui.navigation\",
  enabled: true,
  configuration: { doubleTap: \"sleep\" },
};
void valid;

const invalidNavigation: ExtensionDeclaration = {
  feature: \"ui.navigation\",
  enabled: true,
  configuration: {
    // @ts-expect-error ui.navigation does not accept typography.size
    size: 17,
  },
};
void invalidNavigation;

const invalidTypography: ExtensionDeclaration = {
  feature: \"ui.typography\",
  enabled: true,
  configuration: {
    // @ts-expect-error ui.typography does not accept navigation.doubleTap
    doubleTap: \"sleep\",
  },
};
void invalidTypography;
"""


def generate_java_helpers(features: list[str]) -> str:
    enum_values = ",\n".join(f'        {"FEATURE_" + re.sub(r"[^A-Za-z0-9]", "_", feature).upper()}("{feature}")' for feature in features)
    return f"""package com.faceclaw.sdk;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Generated typed declaration builder; ExtensionContract remains authoritative. */
public final class ExtensionDeclarations {{
    public enum Feature {{
{enum_values};
        public final String id;
        Feature(String id) {{ this.id = id; }}
    }}

    public static Builder builder() {{ return new Builder(); }}

    public static final class Builder {{
        private final JSONArray declarations = new JSONArray();

        public Builder add(Feature feature, boolean enabled) {{
            return add(feature, enabled, new JSONObject());
        }}

        public Builder add(Feature feature, boolean enabled, JSONObject configuration, Feature... requires) {{
            if (feature == null || configuration == null) throw new IllegalArgumentException("feature and configuration required");
            try {{
                JSONObject item = new JSONObject();
                item.put("feature", feature.id);
                item.put("enabled", enabled);
                item.put("configuration", configuration);
                JSONArray dependencies = new JSONArray();
                if (requires != null) for (Feature dependency : requires) {{
                    if (dependency == null) throw new IllegalArgumentException("null dependency");
                    dependencies.put(dependency.id);
                }}
                if (dependencies.length() > 0) item.put("requires", dependencies);
                declarations.put(item);
                return this;
            }} catch (JSONException error) {{
                throw new IllegalArgumentException("Unable to build extension declaration", error);
            }}
        }}

        public JSONArray build() {{
            try {{ return ExtensionContract.declarations(new JSONArray(declarations.toString())); }}
            catch (JSONException error) {{ throw new IllegalArgumentException("Invalid extension declarations", error); }}
        }}
    }}

    private ExtensionDeclarations() {{}}
}}
"""


def describe_rule(rule: str) -> str:
    if rule == "boolean":
        return "boolean"
    if rule == "text":
        return "text, at most 100 characters"
    if re.fullmatch(r"\d+:\d+", rule):
        low, high = rule.split(":")
        return f"integer {low}–{high}"
    if rule.startswith("(?:"):
        return "SDK-bundled filename"
    return " or ".join(f"`{value}`" for value in rule.split("|"))


def generate_reference(features: list[str], rules: dict[str, dict[str, str]]) -> str:
    lines = [
        "# Generated extension contract reference",
        "",
        "This file is generated from `sdk/src/main/java/com/faceclaw/sdk/ExtensionContract.java`.",
        "The Java contract remains authoritative for validation, dependency cycles, owner limits, same-owner checks, semantic compatibility, and runtime bounds.",
        "",
        "| Feature | Configuration key | Accepted value |",
        "| --- | --- | --- |",
    ]
    for feature in features:
        for key, rule in rules[feature].items():
            lines.append(f"| `{feature}` | `{key}` | {describe_rule(rule)} |")
    lines += [
        "",
        "`requires` contains other known feature IDs. The host and SDK reject unknown features, duplicate declarations, self-dependencies, missing dependencies, and cycles.",
        "Configuration properties are optional; an empty object is valid for features that use only the generic `label` field.",
        "",
    ]
    return "\n".join(lines)


def expected_outputs(source_path: Path = SOURCE, output_dir: Path = OUT) -> dict[Path, str]:
    features, rules = parse(source_path.read_text(encoding="utf-8"))
    outputs = {
        output_dir / "extension-contract.schema.json": generate_schema(features, rules),
        output_dir / "extension-contract.d.ts": generate_types(features, rules),
        output_dir / "extension-contract.md": generate_reference(features, rules),
        output_dir / "extension-contract.type-test.ts": generate_type_fixture(),
        output_dir / "ExtensionDeclarations.java": generate_java_helpers(features),
    }
    if source_path == SOURCE and output_dir == OUT:
        outputs[ROOT / "sdk/src/main/java/com/faceclaw/sdk/ExtensionDeclarations.java"] = outputs[output_dir / "ExtensionDeclarations.java"]
    return outputs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if checked-in outputs differ")
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output-dir", type=Path, default=OUT)
    args = parser.parse_args()
    try:
        outputs = expected_outputs(args.source, args.output_dir)
        if args.check:
            stale = [str(path) for path, content in outputs.items() if not path.exists() or path.read_text(encoding="utf-8") != content]
            if stale:
                print("Generated contract artifacts are stale:", *stale, sep="\n  ", file=sys.stderr)
                return 1
            return 0
        args.output_dir.mkdir(parents=True, exist_ok=True)
        for path, content in outputs.items():
            path.write_text(content, encoding="utf-8")
            print(path)
        return 0
    except (OSError, ValueError) as error:
        print(f"contract generation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
