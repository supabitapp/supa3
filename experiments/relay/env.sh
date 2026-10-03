#!/usr/bin/env bash
RELAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/opt/homebrew/bin:$PATH"
export MIX_HOME="${MIX_HOME:-$RELAY_DIR/.mix}"
export HEX_HOME="${HEX_HOME:-$RELAY_DIR/.hex}"
export RELAY_RELEASE="$RELAY_DIR/_build/prod/rel/relay/bin/relay"
ulimit -n 8192 2>/dev/null || true
