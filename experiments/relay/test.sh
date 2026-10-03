#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export GOWORK=off
export GORACE=atexit_sleep_ms=0
if [[ -n "$(gofmt -l cmd internal integration)" ]]; then
  gofmt -l cmd internal integration
  exit 1
fi
go vet ./...
mkdir -p bin
go build -race -o bin/relay-race ./cmd/relay
RELAY_TEST_BINARY="$PWD/bin/relay-race" go test -race -count=1 -timeout=120s ./...
