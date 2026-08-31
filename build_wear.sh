#!/bin/bash
cd "$(dirname "$0")"; source scripts/before_build.sh

cd wear && ./gradlew build "$@"

