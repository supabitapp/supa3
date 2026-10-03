#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/relay ./cmd/relay
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/bench ./cmd/bench
echo "built bin/relay and bin/bench"
