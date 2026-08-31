#!/bin/bash
cd "$(dirname "$0")"; source scripts/before_build.sh

npx nativescript build android "$@"

