#!/usr/bin/env bash
#
# Build the sibling ScouterKit G1 firmware (g1v0), then update Faceclaw's
# embedded copy of it (app/g1/firmware/, via tools/g1_firmware_bundle.py).
#
# Usage:
#   scripts/update_g1_firmware.sh [--gate] [--skip-build] [--allow-uncommitted] VERSION
#
# VERSION is the g1v0 version to build and ship, e.g. 0.5.67. It must be newer
# than the one Faceclaw ships now: the app only offers an install to arms older
# than that, and every build gets a fresh (RSA-PSS) signature, so a rebuild
# under the same version would never reach arms that already run it.
#
#   --gate               also run ScouterKit's emulator gate (scripts/gate.sh
#                        VERSION) before bundling. Needs `scripts/setup.sh
#                        emulator` to have been run once in g1_firmware/.
#   --skip-build         bundle the existing build of VERSION (e.g. one that has
#                        already been gated) instead of rebuilding. With the
#                        version Faceclaw already ships, this refreshes the
#                        manifest's source commit after committing scouter_kit.
#   --allow-uncommitted  bundle firmware whose sources in scouter_kit are not
#                        committed (tests/g1-firmware.test.cjs then fails).
#
# Set SCOUTER_KIT_DIR to use a scouter_kit checkout somewhere other than
# ~/src/scouter_kit. The build uses ScouterKit's podman containers (its
# `scripts/setup.sh build`). If g1_firmware/work/macos/env.sh exists (a native
# macOS build environment with a podman stand-in) it is sourced for the build
# and the gate; set G1_BUILD_ENV to source a different script instead.

set -euo pipefail

usage() {
  sed -n '6,7p' "${BASH_SOURCE[0]}" | sed 's/^# //' >&2
  exit "${1:-2}"
}

GATE=0
SKIP_BUILD=0
ALLOW_UNCOMMITTED=0
VERSION=
while [ $# -gt 0 ]; do
  case "$1" in
    --gate) GATE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --allow-uncommitted) ALLOW_UNCOMMITTED=1 ;;
    -h|--help) usage 0 ;;
    -*) echo "error: unknown option $1" >&2; usage ;;
    *)
      [ -z "$VERSION" ] || usage
      VERSION=$1
      ;;
  esac
  shift
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FACECLAW_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SCOUTER_KIT_DIR="${SCOUTER_KIT_DIR:-"$HOME/src/scouter_kit"}"
FW="$SCOUTER_KIT_DIR/g1_firmware"
BUNDLER="$FACECLAW_DIR/tools/g1_firmware_bundle.py"
MANIFEST_TS="$FACECLAW_DIR/app/g1/firmware/g1v0-image.ts"
BUILD_ENV="${G1_BUILD_ENV:-"$FW/work/macos/env.sh"}"

# The manifest's top-level fields are indented by two spaces; its parts' by six.
manifest_field() {
  sed -n "s/^  \"$1\": \"\\(.*\\)\",\$/\\1/p" "$MANIFEST_TS"
}
SHIPPED_VERSION="$(manifest_field version)"
SHIPPED_SHA256="$(manifest_field sha256)"

if [ -z "$VERSION" ]; then
  echo "error: no VERSION given (Faceclaw ships g1v0 ${SHIPPED_VERSION:-?} now)" >&2
  usage
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: VERSION must look like 0.5.67, not $VERSION" >&2
  exit "${1:-2}"
fi
if [ ! -x "$FW/scripts/build.sh" ]; then
  echo "error: ScouterKit build script not found or not executable: $FW/scripts/build.sh" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required" >&2
  exit 1
fi
if [ -z "$SHIPPED_VERSION" ] || [ -z "$SHIPPED_SHA256" ]; then
  echo "error: cannot read the shipped version and sha256 from $MANIFEST_TS" >&2
  exit 1
fi

# Prints -1, 0 or 1 as $1 is older than, the same as or newer than $2.
compare_versions() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) {
      if (x[i] + 0 < y[i] + 0) { print -1; exit }
      if (x[i] + 0 > y[i] + 0) { print 1; exit }
    }
    print 0
  }'
}
case "$(compare_versions "$VERSION" "$SHIPPED_VERSION")" in
  -1)
    echo "error: Faceclaw already ships g1v0 $SHIPPED_VERSION, newer than $VERSION" >&2
    exit 1
    ;;
  0)
    if [ "$SKIP_BUILD" = 0 ]; then
      echo "error: Faceclaw already ships g1v0 $VERSION; a rebuild needs a new version, or arms" >&2
      echo "already on $VERSION would never be offered it. (--skip-build re-bundles the shipped build.)" >&2
      exit 1
    fi
    ;;
esac

# The same paths tools/g1_firmware_bundle.py checks to mark a source "+uncommitted".
UNCOMMITTED="$(git -C "$FW" status --porcelain -- firmware ../src/vm)"
if [ -n "$UNCOMMITTED" ]; then
  if [ "$ALLOW_UNCOMMITTED" = 0 ]; then
    echo "error: the firmware sources in $SCOUTER_KIT_DIR have uncommitted changes:" >&2
    echo "$UNCOMMITTED" >&2
    echo "Commit them first, or pass --allow-uncommitted (tests/g1-firmware.test.cjs then fails)." >&2
    exit 1
  fi
  echo "warning: bundling firmware built from uncommitted sources" >&2
fi

# Runs a command in g1_firmware/, in the build environment if there is one.
in_scouter_kit() {
  (
    if [ -f "$BUILD_ENV" ]; then
      # shellcheck disable=SC1090
      . "$BUILD_ENV"
    fi
    cd "$FW"
    "$@"
  )
}

# Where scripts/build.sh puts its output (G1_WORK and G1_BUILD may come from the build environment).
BUILD_DIR="$(in_scouter_kit sh -c 'w=${G1_WORK:-$PWD/work}; echo "${G1_BUILD:-$w/build}"')"
v="$(echo "$VERSION" | tr -d .)"
IMAGE="$BUILD_DIR/g1v0-v$v/zephyr/app_update.bin"

if [ "$SKIP_BUILD" = 0 ]; then
  echo "Building g1v0 $VERSION in $FW (four variants; logs in $BUILD_DIR/logs)..."
  BUILD_OUTPUT="$(in_scouter_kit scripts/build.sh "$VERSION" 2>&1)" || true
  echo "$BUILD_OUTPUT"
  # build.sh reports each variant but exits 0 even when one fails, and a failed
  # build can leave an older image behind, so trust only its "ok" line.
  if ! grep -qx "g1v0-v$v ok" <<<"$BUILD_OUTPUT"; then
    LOG="$BUILD_DIR/logs/build-g1v0-v$v.log"
    echo "error: the g1v0 $VERSION build failed" >&2
    if [ -f "$LOG" ]; then
      echo "--- last lines of $LOG:" >&2
      tail -20 "$LOG" >&2
    fi
    exit 1
  fi
fi

if [ ! -f "$IMAGE" ]; then
  echo "error: no build of g1v0 $VERSION at $IMAGE" >&2
  exit 1
fi
IMAGE_VERSION="$(python3 -I - "$IMAGE" <<'PY'
import struct
import sys

with open(sys.argv[1], "rb") as f:
    header = f.read(24)
if len(header) < 24 or header[:4] != bytes.fromhex("3db8f396"):
    print("not an MCUboot image")
else:
    print("%d.%d.%d" % struct.unpack_from("<BBH", header, 20))
PY
)"
if [ "$IMAGE_VERSION" != "$VERSION" ]; then
  echo "error: $IMAGE is g1v0 $IMAGE_VERSION, not $VERSION" >&2
  exit 1
fi
if [ "$VERSION" = "$SHIPPED_VERSION" ]; then
  IMAGE_SHA256="$(python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$IMAGE")"
  if [ "$IMAGE_SHA256" != "$SHIPPED_SHA256" ]; then
    echo "error: $IMAGE is not the g1v0 $VERSION build Faceclaw ships (sha256 $IMAGE_SHA256," >&2
    echo "shipped $SHIPPED_SHA256); a different image needs a new version" >&2
    exit 1
  fi
fi

if [ "$GATE" = 1 ]; then
  echo "Running the emulator gate for g1v0 $VERSION..."
  if ! in_scouter_kit scripts/gate.sh "$VERSION"; then
    echo "error: the emulator gate failed for g1v0 $VERSION. Results are in its work/runs/gate-*/;" >&2
    echo "rerun failing tests with scripts/gate.sh $VERSION TEST..., then this script with --skip-build." >&2
    exit 1
  fi
fi

python3 -I "$BUNDLER" "$IMAGE" --firmware-dir "$FW"

if [ "$VERSION" = "$SHIPPED_VERSION" ]; then
  echo "Re-bundled g1v0 $VERSION (same image)."
else
  echo "Faceclaw now ships g1v0 $VERSION (was $SHIPPED_VERSION)."
  echo "If Faceclaw now requires it, also bump REQUIRED_FIRMWARE in native/kotlin/shared/src/commonMain/kotlin/com/faceclaw/app/g1/G1Protocol.kt."
fi
if [ "$GATE" = 0 ] && [ "$SKIP_BUILD" = 0 ]; then
  echo "This build has not been through the emulator gate: before shipping it, run"
  echo "  (cd $FW && scripts/gate.sh $VERSION)"
  echo "which tests this same build, or rerun this script with --gate."
fi
