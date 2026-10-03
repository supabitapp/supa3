#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
if [[ ! -x "$RELAY_BIN" ]]; then
  echo "relay is not built; run experiments/relay/build.sh first" >&2
  exit 1
fi
exec node "$RELAY_DIR/clients/bench/bench.js"
