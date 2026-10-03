#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$RELAY_DIR"
mix local.hex --force --if-missing >/dev/null
mix local.rebar --force --if-missing >/dev/null
MIX_ENV=prod mix deps.get >/dev/null
MIX_ENV=prod mix compile --warnings-as-errors
MIX_ENV=prod mix release relay --overwrite --quiet
if [ ! -d "$RELAY_DIR/clients/node_modules" ]; then
  (cd "$RELAY_DIR/clients" && npm ci --silent --no-audit --no-fund)
fi
echo "built $RELAY_RELEASE"
