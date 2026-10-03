#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$RELAY_DIR"
echo "== build (release, warnings as errors)"
./build.sh
echo "== compile test env with warnings as errors"
MIX_ENV=test mix compile --warnings-as-errors --force
echo "== ExUnit focused tests"
MIX_ENV=test mix test
echo "== end-to-end tests against the release binary"
cd clients && node --test --test-concurrency=1 test/*.test.mjs
