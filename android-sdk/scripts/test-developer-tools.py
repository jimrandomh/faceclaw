#!/usr/bin/env python3
"""Exercise redaction on hostile diagnostics and exact portable kit coverage."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SECRET = "PRIVATE-NOTIFICATION-CONTENT"


class DeveloperToolsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="faceclaw-tools-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_tool(self, name, path):
        return subprocess.run([sys.executable, str(HERE / name), str(path)], capture_output=True, text=True)

    def diagnostics(self):
        return {"schema": 1, "protocol": 1, "extensionSemantics": 2, "generation": 1,
                "apps": [{"component": SECRET, "sdkVersion": "0.2.0", "connected": True,
                          "extensionCompatible": True, "pendingRequests": 0, "actionsUsed": 4096,
                          "diagnostics": {"request-timeout": 2, "action-ledger-full": 1}, "surfaces": []}],
                "features": [{"feature": "ui.launcher", "component": SECRET, "available": True,
                              "generation": 1, "contenders": [{"component": SECRET, "enabled": True,
                              "granted": True, "connected": True, "reason": "active", "requires": []}]}]}

    def inspect(self, data):
        path = self.root / "diagnostics.json"
        path.write_text(json.dumps(data))
        result = self.run_tool("inspect-apk-diagnostics.py", path)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        return result

    def test_valid_structural_diagnostics_redact_identity(self):
        result = self.inspect(self.diagnostics())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("request-timeout=2", result.stdout)
        self.assertIn("reason=active", result.stdout)

    def test_hostile_values_fail_without_payload_or_traceback(self):
        changes = [lambda d: d.update({SECRET: SECRET}),
                   lambda d: d.update(schema=True),
                   lambda d: d["apps"][0].update(diagnostics={SECRET: 1}),
                   lambda d: d["features"][0]["contenders"][0].update(reason={SECRET: 1}),
                   lambda d: d["features"][0]["contenders"][0].update(requires=[[SECRET]]),
                   lambda d: d["features"][0].update(feature=SECRET)]
        for change in changes:
            with self.subTest(change=change):
                data = copy.deepcopy(self.diagnostics())
                change(data)
                result = self.inspect(data)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stderr, "invalid APK diagnostics\n")

    def test_oversized_and_invalid_encoding_are_bounded(self):
        path = self.root / "diagnostics.json"
        for raw in (b"x" * 1_048_577, b'"\xff"', b"[" * 2000):
            path.write_bytes(raw)
            result = self.run_tool("inspect-apk-diagnostics.py", path)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stderr, "invalid APK diagnostics\n")

    def kit(self):
        root = self.root / "kit"
        root.mkdir()
        (root / "sdk.aar").write_bytes(b"test release")
        (root / "PORTABLE-KIT.json").write_text("{}\n")
        entries = [{"path": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "bytes": p.stat().st_size}
                   for p in sorted(root.iterdir())]
        manifest = {"schema": 1, "coordinate": "com.faceclaw:sdk:0.2.0", "files": entries}
        self.write_manifest(root, manifest)
        return root, manifest

    def write_manifest(self, root, manifest):
        (root / "SHA256SUMS.json").write_text(json.dumps(manifest))
        (root / "SHA256SUMS.txt").write_text("".join(f"{e['sha256']}  {e['path']}\n" for e in manifest["files"]))

    def test_exact_kit_and_tampered_metadata(self):
        root, _ = self.kit()
        self.assertEqual(self.run_tool("verify-portable-kit.py", root).returncode, 0)
        (root / "PORTABLE-KIT.json").write_text('{"changed":true}')
        self.assertEqual(self.run_tool("verify-portable-kit.py", root).returncode, 1)

    def test_nested_manifest_name_cannot_hide_extra_file(self):
        root, _ = self.kit()
        (root / "nested").mkdir()
        (root / "nested/SHA256SUMS.json").write_text("extra")
        self.assertEqual(self.run_tool("verify-portable-kit.py", root).returncode, 1)

    def test_omissions_duplicates_and_symlinks_are_rejected(self):
        root, manifest = self.kit()
        for entries in (manifest["files"][:1], manifest["files"] + manifest["files"][:1]):
            altered = dict(manifest, files=entries)
            self.write_manifest(root, altered)
            self.assertEqual(self.run_tool("verify-portable-kit.py", root).returncode, 1)
        self.write_manifest(root, manifest)
        original = root / "sdk.aar"
        original.rename(self.root / "outside.aar")
        original.symlink_to(self.root / "outside.aar")
        self.assertEqual(self.run_tool("verify-portable-kit.py", root).returncode, 1)


if __name__ == "__main__":
    unittest.main()
