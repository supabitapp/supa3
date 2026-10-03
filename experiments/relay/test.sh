#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"
export MIX_HOME="$PWD/.mix" HEX_HOME="$PWD/.hex" ERL_FLAGS="${ERL_FLAGS:-+S 4:4}"
/opt/homebrew/bin/mix format --check-formatted
MIX_ENV=test /opt/homebrew/bin/mix compile --warnings-as-errors
MIX_ENV=test /opt/homebrew/bin/mix test --warnings-as-errors
npm ci --ignore-scripts --no-audit --no-fund >&2
for file in clients/*.mjs; do node --check "$file"; done
node --test --test-concurrency=1 clients/*.test.mjs
