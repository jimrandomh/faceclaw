#!/usr/bin/env python3
"""Meaningful deterministic/stale/unknown-syntax checks for the contract generator."""
from __future__ import annotations

import pathlib
import subprocess
import tempfile


HERE = pathlib.Path(__file__).resolve().parent
GENERATOR = HERE / "generate-extension-contract.py"
SOURCE = HERE.parent / "sdk/src/main/java/com/faceclaw/sdk/ExtensionContract.java"


def invoke(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([str(GENERATOR), *args], text=True, capture_output=True)


with tempfile.TemporaryDirectory(prefix="faceclaw-generator-test-") as directory:
    root = pathlib.Path(directory)
    source = root / "ExtensionContract.java"
    output = root / "generated"
    original = SOURCE.read_text(encoding="utf-8")
    source.write_text(original, encoding="utf-8")
    first = invoke("--source", str(source), "--output-dir", str(output))
    assert first.returncode == 0, first.stderr
    snapshot = {path.name: path.read_bytes() for path in output.iterdir()}
    second = invoke("--source", str(source), "--output-dir", str(output), "--check")
    assert second.returncode == 0, second.stderr
    assert snapshot == {path.name: path.read_bytes() for path in output.iterdir()}
    typecheck = subprocess.run(
        ["npx", "tsc", "--strict", "--noEmit", "--skipLibCheck", str(output / "extension-contract.type-test.ts")],
        cwd=HERE.parent.parent,
        text=True,
        capture_output=True,
    )
    assert typecheck.returncode == 0, typecheck.stderr

    stale_file = output / "extension-contract.d.ts"
    stale_file.write_text(stale_file.read_text(encoding="utf-8") + "\n// stale\n", encoding="utf-8")
    stale = invoke("--source", str(source), "--output-dir", str(output), "--check")
    assert stale.returncode == 1, stale.stderr

    invalid = source.read_text(encoding="utf-8").replace('rules.put("doubleTap","back|sleep")', 'rules.put("doubleTap","future-token")')
    source.write_text(invalid, encoding="utf-8")
    rejected = invoke("--source", str(source), "--output-dir", str(root / "invalid"))
    assert rejected.returncode == 2, rejected.stderr

    branch_invalid = original.replace(
        'else if(feature.equals("ui.app-menu"))',
        'else if(feature.equals("ui.app-menu") && feature != null)',
    )
    source.write_text(branch_invalid, encoding="utf-8")
    rejected_branch = invoke("--source", str(source), "--output-dir", str(root / "invalid-branch"))
    assert rejected_branch.returncode == 2, rejected_branch.stderr

print("generator deterministic, stale-output, and unknown-rule checks passed")
