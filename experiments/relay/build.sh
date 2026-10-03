#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export GOWORK=off
mkdir -p bin
go build -trimpath -ldflags='-s -w' -o bin/relay ./cmd/relay
go build -trimpath -ldflags='-s -w' -o bin/bench ./cmd/bench
go build -trimpath -ldflags='-s -w' -o bin/client ./cmd/client
