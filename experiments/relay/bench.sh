#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x bin/relay ] || [ ! -x bin/bench ]; then
  echo "bin/relay or bin/bench missing; run ./build.sh first" >&2
  exit 1
fi
OUT="${RELAY_BENCH_OUT:-/tmp/passio-relay-bench/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
echo "raw output: $OUT" >&2
exec ./bin/bench -relay "$PWD/bin/relay" -out "$OUT" "$@"
