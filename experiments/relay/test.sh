#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$RELAY_DIR"
"$RELAY_DIR/build.sh"
mix format --check-formatted
MIX_ENV=test mix compile --warnings-as-errors --force
MIX_ENV=test mix test --no-start --warnings-as-errors
cd clients
node --test --test-concurrency=1 --test-force-exit --test-timeout=60000 "test/*.test.js"
