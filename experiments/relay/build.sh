#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$RELAY_DIR"
mix local.hex --force --if-missing >/dev/null
mix local.rebar --force --if-missing >/dev/null
MIX_ENV=prod mix deps.get --only prod
MIX_ENV=prod mix compile --warnings-as-errors
MIX_ENV=prod mix release --overwrite --quiet
(cd clients && npm ci --no-audit --no-fund --silent)
echo "built $RELAY_BIN" >&2
