#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export ERL_FLAGS="${ERL_FLAGS:-+S 4:4}"
export RELEASE_DISTRIBUTION=none
if [[ ! -x _build/prod/rel/passio_relay/bin/passio_relay ]]; then
  echo 'Run bash experiments/relay/build.sh first.' >&2
  exit 1
fi
exec _build/prod/rel/passio_relay/bin/passio_relay start
