#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
if [ ! -x "$RELAY_RELEASE" ]; then
  echo "relay release not built; run build.sh first" >&2
  exit 1
fi
cd "$RELAY_DIR/clients"
exec node bench/bench.mjs "$@"
