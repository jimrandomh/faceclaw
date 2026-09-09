#!/usr/bin/env bash
set -u -o pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
output_dir="${APK_AUDIT_OUTPUT:-$repo_root/android-sdk/build/apk-audit/$timestamp}"
allow_known=0
if [[ "${1:-}" == "--allow-known-upstream-failures" ]]; then
  allow_known=1
fi
if [[ -e "$output_dir" ]]; then
  printf "Refusing to overwrite audit evidence: %s\n" "$output_dir" >&2
  exit 2
fi
mkdir -p "$output_dir/logs"
output_dir="$(cd "$output_dir" && pwd)"
known_baseline_accepted=0

failures=0
command_index=0
run_command() {
  local name="$1"
  shift
  command_index=$((command_index + 1))
  local log="$output_dir/logs/$(printf '%02d' "$command_index")-$name.log"
  local status
  printf '$'
  printf ' %q' "$@"
  printf '\n'
  set +e
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  printf '%s\n' "$status" > "$log.status"
  python3 - "$output_dir/commands.jsonl" "$name" "$status" "$log" "$@" <<'PY'
import json
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
record = {"name": sys.argv[2], "status": int(sys.argv[3]), "log": sys.argv[4], "argv": sys.argv[5:]}
with path.open("a", encoding="utf-8") as stream:
    stream.write(json.dumps(record, separators=(",", ":")) + "\n")
PY
  return "$status"
}

required() {
  if ! run_command "$@"; then
    failures=$((failures + 1))
    return 1
  fi
}

printf 'APK platform audit output: %s\n' "$output_dir"
printf 'revision: ' > "$output_dir/revision.txt"
git -C "$repo_root" rev-parse HEAD >> "$output_dir/revision.txt"
git -C "$repo_root" status --short >> "$output_dir/revision.txt"
required toolchain-doctor python3 "$repo_root/android-sdk/scripts/doctor.py" --json || true
run_command tool-java java -version || failures=$((failures + 1))
run_command tool-node node --version || failures=$((failures + 1))
run_command tool-gradle env AUDIT_REPO_ROOT="$repo_root" bash -c 'cd "$AUDIT_REPO_ROOT/android-sdk" && ./gradlew --version' || failures=$((failures + 1))
run_command tool-android-sdk bash -c 'if command -v sdkmanager >/dev/null 2>&1; then sdkmanager --list_installed | sed -n "1,80p"; else echo "sdkmanager unavailable"; exit 127; fi' || failures=$((failures + 1))

required generator-check "$repo_root/android-sdk/scripts/generate-extension-contract.py" --check || true
required generator-tests python3 "$repo_root/android-sdk/scripts/test-generator.py" || true
required developer-tools-tests python3 "$repo_root/android-sdk/scripts/test-developer-tools.py" || true
required host-typecheck env AUDIT_REPO_ROOT="$repo_root" bash -c 'cd "$AUDIT_REPO_ROOT" && npx tsc --noEmit -p tsconfig.json' || true

host_test_log="$output_dir/logs/$(printf '%02d' $((command_index + 1)))-host-tests.log"
if run_command host-tests env AUDIT_REPO_ROOT="$repo_root" bash -c 'cd "$AUDIT_REPO_ROOT" && npm test'; then
  :
else
  if [[ "$allow_known" == 1 ]]; then
    if python3 - "$host_test_log" "$repo_root/android-sdk/scripts/known-host-test-failures.txt" <<'PY'
import pathlib
import re
import sys

log = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
baseline = {
    line.strip() for line in pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").splitlines()
    if line.strip() and not line.lstrip().startswith("#")
}
found = {match.group(1).strip() for match in re.finditer(r"^✖ (.+?) \([^\n]*\)$", log, re.MULTILINE)}
found.update(match.group(1).strip() for match in re.finditer(r"^\s*not ok \d+ - (.+)$", log, re.MULTILINE))
counts = re.findall(r"^(?:ℹ|#) fail (\d+)\s*$", log, re.MULTILINE)
if found != baseline or not counts or int(counts[-1]) != len(baseline):
    print("unexpected host test failure set", file=sys.stderr)
    print("expected:", sorted(baseline), file=sys.stderr)
    print("found:", sorted(found), file=sys.stderr)
    raise SystemExit(1)
print("host test status is the exact documented upstream baseline")
PY
    then
      known_baseline_accepted=1
      printf 'Known upstream host failures were surfaced and matched exactly.\n' >> "$host_test_log"
    else
      failures=$((failures + 1))
    fi
  else
    printf 'Host tests failed. Re-run with --allow-known-upstream-failures only when reviewing the exact scoped baseline.\n' >> "$host_test_log"
    failures=$((failures + 1))
  fi
fi

sdk_dir="$repo_root/android-sdk"
required sdk-gradle env AUDIT_SDK_DIR="$sdk_dir" bash -c 'cd "$AUDIT_SDK_DIR" && ./gradlew :sdk:testDebugUnitTest :sdk:assembleRelease :sdk:lintDebug' || true
kit="$output_dir/portable-kit"
if required portable-export "$sdk_dir/scripts/export-portable-kit.sh" "$kit"; then
  required portable-checksum python3 "$sdk_dir/scripts/verify-portable-kit.py" "$kit" || true
  required portable-doc-links python3 "$sdk_dir/scripts/check-doc-links.py" "$kit" || true
  required scaffold-consumer-build python3 "$sdk_dir/scripts/test-scaffolds.py" "$kit" "$output_dir/scaffolds" || true
  standalone_copy="$(mktemp -d "${TMPDIR:-/tmp}/faceclaw-apk-standalone.XXXXXX")"
  cp -a "$kit" "$standalone_copy/kit"
  if required starter-standalone-build env AUDIT_STANDALONE="$standalone_copy" bash -c 'cd "$AUDIT_STANDALONE/kit/starter" && ./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug'; then
    mkdir -p "$output_dir/artifacts"
    cp "$standalone_copy/kit/starter/app/build/outputs/apk/debug/app-debug.apk" "$output_dir/artifacts/starter-debug.apk"
    cp "$standalone_copy/kit/starter/app/build/reports/lint-results-debug.html" "$output_dir/artifacts/starter-lint.html"
  fi
  required examples-standalone-build python3 "$sdk_dir/scripts/test-examples.py" "$kit" "$output_dir/examples" || true
  rm -rf "$standalone_copy"
else
  printf 'Skipping standalone build because portable export failed.\n' >> "$output_dir/summary.md"
fi

python3 - "$output_dir" "$failures" "$allow_known" "$known_baseline_accepted" <<'PY'
import json
import pathlib
import sys

out = pathlib.Path(sys.argv[1])
records = [json.loads(line) for line in (out / "commands.jsonl").read_text(encoding="utf-8").splitlines() if line]
summary = {
    "schema": 1,
    "revision": (out / "revision.txt").read_text(encoding="utf-8").splitlines()[0].split(": ", 1)[-1],
    "allowKnownUpstreamFailures": bool(int(sys.argv[3])),
    "knownUpstreamBaselineAccepted": bool(int(sys.argv[4])),
    "failures": int(sys.argv[2]),
    "commands": records,
}
(out / "audit.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
lines = [f"# APK platform audit ({summary['revision']})", "", f"Result: {'PASS' if not summary['failures'] else 'FAIL'}", "", "| Command | Status | Evidence |", "| --- | ---: | --- |"]
for record in records:
    lines.append(f"| `{record['name']}` | {record['status']} | `{record['log']}` |")
if summary["knownUpstreamBaselineAccepted"]:
    lines += ["", "Eight exact upstream test failures were accepted. Raw host tests failed; no unexpected host failures occurred."]
lines += ["", "The audit records the exact revision, tool probes, command argv, exit status, and command logs in this directory.", "The emulator priority demo is a separate, synthetic-host evidence job and is never installed on a physical glasses host.", ""]
(out / "summary.md").write_text("\n".join(lines), encoding="utf-8")
PY

if [[ "$failures" -ne 0 ]]; then
  printf 'APK platform audit FAILED (%s command/check failures). Evidence: %s\n' "$failures" "$output_dir" >&2
  exit 1
fi
printf 'APK platform audit passed. Evidence: %s\n' "$output_dir"
