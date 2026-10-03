#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x bin/relay ]; then
  echo "bin/relay missing; run ./build.sh first" >&2
  exit 1
fi
exec ./bin/relay "$@"
