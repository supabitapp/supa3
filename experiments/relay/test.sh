#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
./build.sh >/dev/null
export RELAY_BINARY="$PWD/bin/relay"
gofmt_out="$(gofmt -l .)"
if [ -n "$gofmt_out" ]; then
  echo "gofmt needed:" "$gofmt_out" >&2
  exit 1
fi
go vet ./...
go test -race -count=1 -timeout 180s ./... "$@"
