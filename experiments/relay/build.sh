#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"
export MIX_HOME="$PWD/.mix" HEX_HOME="$PWD/.hex" MIX_ENV=prod
export ERL_FLAGS="${ERL_FLAGS:-+S 4:4}"
if [[ ! -d "$MIX_HOME/archives" ]]; then /opt/homebrew/bin/mix local.hex --force >&2; fi
if ! find "$MIX_HOME" -name rebar3 -type f | read -r _; then /opt/homebrew/bin/mix local.rebar --force >&2; fi
/opt/homebrew/bin/mix deps.get >&2
/opt/homebrew/bin/mix compile --warnings-as-errors >&2
/opt/homebrew/bin/mix release --overwrite >&2
