#!/bin/bash
# Build signed release APKs and AABs at dist/Faceclaw-<version>.{apk,aab}
# (phone) and dist/Faceclaw-Wear-<version>.{apk,aab} (watch), where <version>
# comes from FACECLAW_VERSION in app/version.ts. All use the same key:
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

export FACECLAW_ANDROID_BUILD_REVISION="${FACECLAW_ANDROID_BUILD_REVISION:-0}"
case "$FACECLAW_ANDROID_BUILD_REVISION" in
  [0-4]) ;;
  *) echo "FACECLAW_ANDROID_BUILD_REVISION must be an integer from 0 to 4" >&2; exit 1 ;;
esac

if [ ! -f "${ANDROID_KEYSTORE:-}" ]; then
  echo "Keystore not found: ${ANDROID_KEYSTORE:-unset} (set ANDROID_KEYSTORE in build_paths.sh)" >&2
  exit 1
fi

# before_build.sh loads JAVA_HOME/ANDROID_HOME from build_paths.sh.
if ! command -v keytool >/dev/null; then
  echo "keytool not found; set JAVA_HOME and PATH in build_paths.sh" >&2
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
echo "Signing as '$ALIAS', version $VERSION, Android build revision $FACECLAW_ANDROID_BUILD_REVISION"

read -r -s -p "Key passphrase for '$ALIAS' (empty = same as keystore): " KEY_PASS
echo
KEY_PASS="${KEY_PASS:-$STORE_PASS}"

OUT="dist/Faceclaw-$VERSION.apk"
BUNDLE_OUT="dist/Faceclaw-$VERSION.aab"
WEAR_OUT="dist/Faceclaw-Wear-$VERSION.apk"
WEAR_BUNDLE_OUT="dist/Faceclaw-Wear-$VERSION.aab"
mkdir -p dist
# Keep existing release artifacts until every build and verification succeeds.
STAGING_DIR="$(mktemp -d "$ROOT/dist/.release-XXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT

PHONE_SIGNING_ARGS=(
  --key-store-path "$ANDROID_KEYSTORE"
  --key-store-password "$STORE_PASS"
  --key-store-alias "$ALIAS"
  --key-store-alias-password "$KEY_PASS"
)

echo "=== Building Android app ==="
npx nativescript build android --release \
  "${PHONE_SIGNING_ARGS[@]}" --copy-to "$STAGING_DIR/phone.apk"

echo "=== Building Android app bundle ==="
npx nativescript build android --release --aab \
  "${PHONE_SIGNING_ARGS[@]}" --copy-to "$STAGING_DIR/phone.aab"

# Wear app: sign with the same key via AGP's injected signing properties, so
# no signing config needs to live in the wear build files.
echo "=== Building Wear app ==="
(cd wear && ./gradlew :app:assembleRelease :app:bundleRelease \
  -Pandroid.injected.signing.store.file="$ANDROID_KEYSTORE" \
  -Pandroid.injected.signing.store.password="$STORE_PASS" \
  -Pandroid.injected.signing.key.alias="$ALIAS" \
  -Pandroid.injected.signing.key.password="$KEY_PASS")
cp wear/app/build/outputs/apk/release/app-release.apk "$STAGING_DIR/wear.apk"
cp wear/app/build/outputs/bundle/release/app-release.aab "$STAGING_DIR/wear.aab"
if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/build-tools" ]; then
  APKSIGNER="$(printf '%s\n' "$ANDROID_HOME/build-tools"/*/apksigner | sort -V | tail -1)"
  if [ -x "$APKSIGNER" ]; then
    for apk in "$STAGING_DIR/phone.apk" "$STAGING_DIR/wear.apk"; do
      echo "== $apk"
      "$APKSIGNER" verify --print-certs "$apk"
    done
  fi
fi

# AABs use JAR signing, not APK signing. jarsigner can return success for an
# unsigned ZIP, so require its explicit verification result too.
for bundle in "$STAGING_DIR/phone.aab" "$STAGING_DIR/wear.aab"; do
  echo "== $bundle"
  if ! jarsigner -J-Duser.language=en -J-Duser.country=US -verify "$bundle" > "$STAGING_DIR/jarsigner.log" 2>&1 \
      || ! grep -q '^jar verified\.' "$STAGING_DIR/jarsigner.log"; then
    cat "$STAGING_DIR/jarsigner.log" >&2
    echo "App bundle signature could not be verified: $bundle" >&2
    exit 1
  fi
  echo "App bundle signature verified."
done

mv "$STAGING_DIR/phone.apk" "$OUT"
mv "$STAGING_DIR/phone.aab" "$BUNDLE_OUT"
mv "$STAGING_DIR/wear.apk" "$WEAR_OUT"
mv "$STAGING_DIR/wear.aab" "$WEAR_BUNDLE_OUT"
printf '\nBuilt %s\n' "$OUT" "$BUNDLE_OUT" "$WEAR_OUT" "$WEAR_BUNDLE_OUT"
