#!/usr/bin/env bash
#
# resetOnboardingIos.sh — reset Faceclaw on an iPhone back to its pre-onboarding
# state, for testing the onboarding flow repeatedly. The iOS counterpart of
# resetOnboarding.sh.
#
# By default this only clears the onboarding-related preference keys
# (onboarding.complete, onboarding.previewOnly, the on-glasses onboarding's
# onboarding.glassesFinishedVersion, ...) and leaves everything else, notably
# the saved glasses/ring identities, intact. It restarts Faceclaw twice, and
# leaves it running in onboarding. Pass --all to uninstall the app instead,
# which wipes ALL of its data and permissions; you then have to reinstall it.
#
# Usage:
#   scripts/resetOnboardingIos.sh                  # reset onboarding flags only
#   scripts/resetOnboardingIos.sh --all            # uninstall (wipes everything)
#   scripts/resetOnboardingIos.sh -d <device-id>   # target a specific iPhone
#   scripts/resetOnboardingIos.sh --simulator      # target the booted simulator
#
# The device defaults to IOS_DEVICE from build_paths.sh, then to the only iPhone
# connected. Needs Xcode and an unlocked phone with a development build installed;
# see config-transfer.md.

# Sourced ahead of strict mode, since the build scripts source it without one.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/build_paths.sh" ]; then
  source "$ROOT/build_paths.sh"
fi

set -euo pipefail

# ios_config.py reads these from its environment.
export IOS_DEVICE IOS_BUNDLE_ID

exec python3 "$ROOT/scripts/ios_config.py" reset-onboarding "$@"
