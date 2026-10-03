#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x _build/prod/rel/passio_relay/bin/passio_relay || ! -d node_modules/ws ]]; then
  echo 'Run build.sh and test.sh before bench.sh.' >&2
  exit 1
fi
exec node clients/bench.mjs
