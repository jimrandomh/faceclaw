#!/bin/bash
# Build signed release APKs at dist/Faceclaw-<version>.apk (phone) and
# dist/Faceclaw-Wear-<version>.apk (watch), where <version> comes from
# FACECLAW_VERSION in app/version.ts. Both are signed with the same key:
# the Wearable Data Layer only routes between apps with matching package
# names and signing keys.
#
# Prompts for the keystore passphrase. Override the keystore location with
# ANDROID_KEYSTORE=/path/to/store.jks.
#
# Note: the passphrase is passed to the nativescript CLI and Gradle on their
# command lines, so it is briefly visible in `ps` on this machine while the
# build runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source scripts/before_build.sh

if [ ! -f "$ANDROID_KEYSTORE" ]; then
  echo "Keystore not found: $ANDROID_KEYSTORE (set ANDROID_KEYSTORE in build_paths.sh)" >&2
  exit 1
fi

# build.sh is the machine-specific wrapper that exports JAVA_HOME/ANDROID_HOME.
# Pick up its exports so keytool and the build use the same JDK.
if [ -f build.sh ]; then
  eval "$(grep '^export ' build.sh)"
fi
if ! command -v keytool >/dev/null; then
  echo "keytool not found; set JAVA_HOME (usually via build.sh)" >&2
  exit 1
fi

VERSION="$(sed -n 's/^export const FACECLAW_VERSION = "\([^"]*\)".*/\1/p' app/version.ts)"
if [ -z "$VERSION" ]; then
  echo "Could not read FACECLAW_VERSION from app/version.ts" >&2
  exit 1
fi

read -r -s -p "Keystore passphrase for $(basename "$ANDROID_KEYSTORE"): " STORE_PASS
echo

# Validate the passphrase up front and discover the signing-key alias.
if ! LISTING="$(keytool -list -keystore "$ANDROID_KEYSTORE" -storepass "$STORE_PASS" 2>&1)"; then
  printf '%s\n' "$LISTING" >&2
  exit 1
fi
ALIAS="$(printf '%s\n' "$LISTING" | awk -F', ' '/PrivateKeyEntry/{print $1; exit}')"
if [ -z "$ALIAS" ]; then
  echo "No private-key entry found in $ANDROID_KEYSTORE:" >&2
  printf '%s\n' "$LISTING" >&2
  exit 1
fi
echo "Signing as '$ALIAS', version $VERSION"

read -r -s -p "Key passphrase for '$ALIAS' (empty = same as keystore): " KEY_PASS
echo
KEY_PASS="${KEY_PASS:-$STORE_PASS}"

OUT="dist/Faceclaw-$VERSION.apk"
WEAR_OUT="dist/Faceclaw-Wear-$VERSION.apk"
mkdir -p dist
rm -f "$OUT" "$WEAR_OUT"

echo "=== Building Android app ==="
npx nativescript build android --release \
  --key-store-path "$ANDROID_KEYSTORE" \
  --key-store-password "$STORE_PASS" \
  --key-store-alias "$ALIAS" \
  --key-store-alias-password "$KEY_PASS" \
  --copy-to "$OUT"

# Wear app: sign with the same key via AGP's injected signing properties, so
# no signing config needs to live in the wear build files.
echo "=== Building Wear app ==="
(cd wear && ./gradlew :app:assembleRelease \
  -Pandroid.injected.signing.store.file="$ANDROID_KEYSTORE" \
  -Pandroid.injected.signing.store.password="$STORE_PASS" \
  -Pandroid.injected.signing.key.alias="$ALIAS" \
  -Pandroid.injected.signing.key.password="$KEY_PASS")
cp wear/app/build/outputs/apk/release/app-release.apk "$WEAR_OUT"

echo
echo "Built $OUT"
echo "Built $WEAR_OUT"
if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/build-tools" ]; then
  APKSIGNER="$(printf '%s\n' "$ANDROID_HOME/build-tools"/*/apksigner | sort -V | tail -1)"
  if [ -x "$APKSIGNER" ]; then
    for apk in "$OUT" "$WEAR_OUT"; do
      echo "== $apk"
      "$APKSIGNER" verify --print-certs "$apk" | head -5
    done
  fi
fi
