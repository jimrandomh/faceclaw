#!/usr/bin/env python3
"""Strict, redacted inspector for the host's copied APK diagnostics JSON."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

KNOWN_FEATURES = {
    "ui.launcher", "ui.navigation", "ui.app-menu", "ui.window-layout",
    "ui.typography", "ui.notifications", "assistant", "transcription",
    "refinement", "device-tools", "notification-content",
}
KNOWN_REASONS = {"callback-failed", "ipc-rejected", "extension-incompatible", "request-timeout", "action-ledger-full"}
KNOWN_CONTENDER_REASONS = {
    "incompatible", "undeclared", "disabled", "grant-required", "dependency-owner",
    "dependency-unavailable", "disconnected", "active", "lower-priority",
}
MAX_DIAGNOSTICS_BYTES = 1_048_576


def fail(message: str) -> "NoReturn":
    raise ValueError(message)


def keys(value: dict, expected: set[str], where: str) -> None:
    unknown = set(value) - expected
    if unknown:
        fail(f"{where}: unknown field")


def integer(value, where: str, minimum: int = 0, maximum: int = 1_000_000_000) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        fail(f"{where}: expected bounded integer")


def string(value, where: str, maximum: int = 512) -> None:
    if not isinstance(value, str) or not value or len(value) > maximum:
        fail(f"{where}: expected non-empty bounded string")


def validate(data: dict) -> None:
    if not isinstance(data, dict):
        fail("root: expected object")
    keys(data, {"schema", "protocol", "extensionSemantics", "generation", "apps", "features"}, "root")
    for field in ("schema", "protocol", "extensionSemantics"):
        integer(data.get(field), field)
    if data.get("schema") != 1 or data.get("protocol") != 1 or data.get("extensionSemantics") != 2:
        fail("root: unsupported diagnostics schema/protocol/extensionSemantics")
    integer(data.get("generation"), "generation")
    apps = data.get("apps")
    features = data.get("features")
    if not isinstance(apps, list) or len(apps) > 128:
        fail("apps: expected at most 128 entries")
    if not isinstance(features, list) or len(features) > 11:
        fail("features: expected at most 11 entries")
    app_components = set()
    for index, app in enumerate(apps):
        where = f"apps[{index}]"
        if not isinstance(app, dict):
            fail(f"{where}: expected object")
        keys(app, {"component", "sdkVersion", "connected", "extensionCompatible", "pendingRequests", "actionsUsed", "diagnostics", "surfaces"}, where)
        string(app.get("component"), f"{where}.component")
        if app["component"] in app_components:
            fail(f"{where}.component: duplicate component")
        app_components.add(app["component"])
        string(app.get("sdkVersion"), f"{where}.sdkVersion", 32)
        if not isinstance(app.get("connected"), bool) or not isinstance(app.get("extensionCompatible"), bool):
            fail(f"{where}: connected and extensionCompatible must be booleans")
        integer(app.get("pendingRequests"), f"{where}.pendingRequests", maximum=32)
        integer(app.get("actionsUsed"), f"{where}.actionsUsed", maximum=4096)
        diagnostics = app.get("diagnostics")
        if not isinstance(diagnostics, dict):
            fail(f"{where}.diagnostics: expected object")
        for reason, count in diagnostics.items():
            if reason not in KNOWN_REASONS:
                fail(f"{where}.diagnostics: unknown reason")
            integer(count, f"{where}.diagnostics", maximum=1_000_000)
        surfaces = app.get("surfaces")
        if not isinstance(surfaces, list) or len(surfaces) > 11:
            fail(f"{where}.surfaces: expected at most 11 entries")
        for surface_index, surface in enumerate(surfaces):
            surface_where = f"{where}.surfaces[{surface_index}]"
            if not isinstance(surface, dict):
                fail(f"{surface_where}: expected object")
            keys(surface, {"feature", "width", "height", "generation", "sequence", "visible", "screenOn"}, surface_where)
            string(surface.get("feature"), f"{surface_where}.feature", 64)
            if surface["feature"] not in KNOWN_FEATURES:
                fail(f"{surface_where}.feature: unknown feature")
            integer(surface.get("width"), f"{surface_where}.width", minimum=1, maximum=640)
            integer(surface.get("height"), f"{surface_where}.height", minimum=1, maximum=480)
            integer(surface.get("generation"), f"{surface_where}.generation")
            integer(surface.get("sequence"), f"{surface_where}.sequence")
            if not isinstance(surface.get("visible"), bool) or not isinstance(surface.get("screenOn"), bool):
                fail(f"{surface_where}: visible and screenOn must be booleans")
    feature_names = set()
    for index, feature in enumerate(features):
        where = f"features[{index}]"
        if not isinstance(feature, dict):
            fail(f"{where}: expected object")
        keys(feature, {"feature", "component", "available", "generation", "contenders"}, where)
        string(feature.get("feature"), f"{where}.feature", 64)
        if feature["feature"] not in KNOWN_FEATURES:
            fail(f"{where}.feature: unknown feature")
        if feature["feature"] in feature_names:
            fail(f"{where}.feature: duplicate feature")
        feature_names.add(feature["feature"])
        component = feature.get("component")
        if component != "":
            string(component, f"{where}.component")
        if not isinstance(feature.get("available"), bool):
            fail(f"{where}.available: expected boolean")
        integer(feature.get("generation"), f"{where}.generation")
        contenders = feature.get("contenders")
        if not isinstance(contenders, list) or len(contenders) > 128:
            fail(f"{where}.contenders: expected at most 128 entries")
        for contender_index, contender in enumerate(contenders):
            contender_where = f"{where}.contenders[{contender_index}]"
            if not isinstance(contender, dict):
                fail(f"{contender_where}: expected object")
            keys(contender, {"component", "enabled", "granted", "connected", "reason", "requires"}, contender_where)
            string(contender.get("component"), f"{contender_where}.component")
            for field in ("enabled", "granted", "connected"):
                if not isinstance(contender.get(field), bool):
                    fail(f"{contender_where}.{field}: expected boolean")
            reason = contender.get("reason")
            if not isinstance(reason, str) or reason not in KNOWN_CONTENDER_REASONS:
                fail(f"{contender_where}.reason: unknown reason")
            requires = contender.get("requires")
            if not isinstance(requires, list) or len(requires) > 11 or any(not isinstance(item, str) or item not in KNOWN_FEATURES for item in requires) or len(set(requires)) != len(requires):
                fail(f"{contender_where}.requires: expected bounded string list")


def redacted(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:10]


def report(data: dict) -> str:
    lines = [
        f"diagnostics schema={data['schema']} protocol={data['protocol']} extensionSemantics={data['extensionSemantics']} generation={data['generation']}",
        f"apps={len(data['apps'])} features={len(data['features'])}",
    ]
    for app in data["apps"]:
        status = "connected" if app["connected"] else "disconnected"
        compatibility = "compatible" if app["extensionCompatible"] else ("app-update-needed" if app["sdkVersion"] != "0.3.0" else "app-incompatible")
        reasons = ", ".join(f"{key}={count}" for key, count in sorted(app["diagnostics"].items())) or "none"
        lines.append(f"app {redacted(app['component'])}: {status}, {compatibility}, pending={app['pendingRequests']}, actions={app['actionsUsed']}, reasons={reasons}")
        for surface in app["surfaces"]:
            first_frame = "first-frame-absent" if surface["sequence"] == 0 else f"sequence={surface['sequence']}"
            lines.append(f"  surface {surface['feature']}: {surface['width']}x{surface['height']}, {first_frame}, visible={surface['visible']}, screenOn={surface['screenOn']}")
    for feature in data["features"]:
        owner = redacted(feature["component"]) if feature["component"] else "host-fallback"
        lines.append(f"feature {feature['feature']}: owner={owner}, available={feature['available']}, generation={feature['generation']}, contenders={len(feature['contenders'])}")
        for index, contender in enumerate(feature["contenders"], start=1):
            required = ",".join(contender["requires"]) if contender["requires"] else "none"
            lines.append(f"  contender {index}: owner={redacted(contender['component'])}, enabled={contender['enabled']}, granted={contender['granted']}, connected={contender['connected']}, reason={contender['reason']}, requires={required}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("json_file", type=Path)
    args = parser.parse_args()
    try:
        if args.json_file.stat().st_size > MAX_DIAGNOSTICS_BYTES:
            raise ValueError("input exceeds bounded diagnostics size")
        with args.json_file.open("rb") as stream:
            raw = stream.read(MAX_DIAGNOSTICS_BYTES + 1)
        if len(raw) > MAX_DIAGNOSTICS_BYTES: raise ValueError("oversized input")
        data = json.loads(raw)
        validate(data)
        print(report(data))
        return 0
    except (OSError, json.JSONDecodeError, ValueError, TypeError, RecursionError):
        print("invalid APK diagnostics", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
