# Passio relay (Elixir)

A single-node WebSocket relay that pairs a registered host with incoming clients and forwards opaque
messages between them. The relay never interprets application payloads, never terminates application
encryption, and never authorizes clients; those belong to the endpoints.

Everything lives in this directory. Dependencies, builds, and package caches stay under `experiments/relay/`
and are gitignored.

## Commands

```sh
experiments/relay/build.sh   # MIX_ENV=prod release at _build/prod/rel/relay, plus clients/node_modules
experiments/relay/run.sh     # runs the built release; configure with RELAY_* environment variables
experiments/relay/test.sh    # compile with warnings as errors, ExUnit, then end-to-end Node tests
experiments/relay/bench.sh   # benchmark the built release; prints a JSON report to stdout
```

Benchmarks on the shared machine go through the advisory lock:

```sh
python3 /tmp/passio-relay-benchmark-lock.py -- bash experiments/relay/bench.sh > /tmp/relay-bench-report.json
```

`BENCH_OUT=/path` picks the raw output directory (default `$TMPDIR/passio-relay-bench/<timestamp>`), and
`BENCH_QUICK=1` runs a shortened matrix for smoke checks.

Toolchain: Erlang/OTP 29 and Elixir 1.20 from Homebrew (`/opt/homebrew/bin/mix`), Node 26 for the test
clients and benchmark drivers. `env.sh` points `MIX_HOME`/`HEX_HOME` at `.mix`/`.hex` inside this directory so
nothing touches the global toolchain.

## Startup output

On success the relay prints exactly one JSON line to stdout and logs everything else to stderr:

```json
{"event":"listening","address":"127.0.0.1:8080"}
```

`RELAY_ADDR=127.0.0.1:0` binds an ephemeral port and the line carries the actual port. Invalid configuration
prints `relay: <message>` to stderr and exits with status 2.

## Protocol

All Base64URL values are canonical and unpadded. `endpointId` is the lowercase hex SHA-256 of the raw
32-byte Ed25519 host public key.

| Endpoint | Role | Notes |
| --- | --- | --- |
| `GET /healthz` | ops | `200 {"status":"ok"}`, or `503 {"status":"draining"}` during drain |
| `GET /metrics` | ops | JSON counters, see below |
| `GET /v1/control?publicKey=B64` | host | authenticated control channel |
| `GET /v1/connect?endpointId=HEX` | client | data channel; `404` if the host is not registered |
| `GET /v1/accept?endpointId=HEX&connectionId=ID&token=TOKEN` | host | data channel for one pending pair |

Host registration:

1. Relay sends `{"type":"challenge","nonce":"B64(32 random bytes)"}`.
2. Host signs the UTF-8 bytes `"passio-relay-v1\n" + endpointId + "\n" + nonce` (no trailing newline) and
   replies `{"type":"authenticate","signature":"B64(64 bytes)"}`.
3. Relay verifies against the query public key and answers `{"type":"registered","endpointId":"HEX"}`.

The nonce belongs to the socket, is consumed by the first authenticate attempt, and expires after
`RELAY_AUTH_TIMEOUT_MS`. Bad or replayed signatures, non-canonical keys, non-text frames, and a second
registration for an already active endpoint all close with `1008`; the existing host is untouched. Once the
old control socket is gone the host can register again. Control frames are capped at 4 KiB regardless of
`RELAY_MAX_MESSAGE_BYTES`.

Pairing:

1. A client connects; the relay allocates a random 16-byte `connectionId` and 32-byte `token` and tells the
   host `{"type":"incoming","connectionId":"...","token":"..."}`. The client socket receives no relay JSON.
2. The host opens `/v1/accept` with that token. The token is single use, bound to that pair and to the
   host's current registration generation. Wrong, reused, expired, or stale tokens are rejected before the
   upgrade with `403` (bad token) or `404` (unknown pair or host).
3. Both data sockets now forward every complete text or binary message unchanged, in order, in both
   directions. Messages the client sends before pairing are buffered within `RELAY_MAX_QUEUE_BYTES` and
   `RELAY_MAX_QUEUE_MESSAGES` and drained after pairing.

Close handling:

- When one data socket closes, the other side is closed and the host receives
  `{"type":"closed","connectionId":"..."}` exactly once per released pair.
- A legal received close code and reason (1000-1003, 1007-1011, 3000-4999) is forwarded to the peer.
  Abnormal closes map to `1001`, a protocol error to `1002`, invalid text to `1007`.
- Oversize messages close the pair with `1009`. Queue or pending-buffer overflow closes it with `1013`.
- Pair timeout and host disconnect close waiting or paired sockets with `1001`.
- Closing the control socket releases every pending and active pair for that host.

Admission rejections before the upgrade: `400` malformed request, `403`/`404` as above, `429` per-IP rate
limit, `503` connection limits or drain.

### Metrics

```json
{"activeHosts":0,"activePairs":0,"pendingPairs":0,"forwardedMessages":0,"forwardedBytes":0,"rejectedConnections":0,"draining":false}
```

Payloads, tokens, nonces, signatures, and keys are never exposed or logged.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_ADDR` | `127.0.0.1:8080` | Bind address as `IP:PORT` or `[IPv6]:PORT`. Port 0 picks a free port. |
| `RELAY_MAX_MESSAGE_BYTES` | `1048576` | Largest data message. Larger closes the pair with 1009. |
| `RELAY_MAX_QUEUE_BYTES` | `4194304` | Per data direction: bytes queued toward a peer, including pre-pair buffering. |
| `RELAY_MAX_QUEUE_MESSAGES` | `256` | Per data direction message cap; also caps unacknowledged control notifications per host. |
| `RELAY_MAX_CLIENTS` | `1024` | Global pending plus active pairs. |
| `RELAY_MAX_CLIENTS_PER_HOST` | `128` | Pending plus active pairs for one host. |
| `RELAY_MAX_PENDING_PER_HOST` | `32` | Pairs awaiting accept for one host. |
| `RELAY_AUTH_TIMEOUT_MS` | `5000` | Time to authenticate a control socket. |
| `RELAY_PAIR_TIMEOUT_MS` | `5000` | Time for a host to accept a pending client. |
| `RELAY_WRITE_TIMEOUT_MS` | `5000` | TCP send timeout; a socket whose write stalls that long is closed. |
| `RELAY_HEARTBEAT_MS` | `15000` | Relay ping interval. A socket that misses one pong is closed at the next tick, so at most twice this value. |
| `RELAY_ADMISSION_RATE` | `100` | Admission attempts per second per IP. Burst capacity equals the rate. |
| `RELAY_ADMISSION_MAX_SOURCES` | `10000` | Tracked IPs for rate limiting. Idle entries expire after 10 s; at the cap the least recently seen entry is evicted. |
| `RELAY_TRUST_FORWARDED_FOR` | `false` | Use the last `X-Forwarded-For` entry as the client IP. Only enable behind a trusted proxy. |

All numeric values must be positive integers; anything else fails startup.

### Backpressure model

Forwarding is process to process. The receiving socket process acknowledges each message when it dequeues
it, and the sending side counts unacknowledged bytes and messages. If the peer stops reading, its socket
process blocks on the TCP write, acknowledgements stop, the sender's queue reaches the limit, and the pair is
closed with `1013`. The blocked write itself is bounded by `RELAY_WRITE_TIMEOUT_MS`. Other pairs are unaffected
because every socket is its own process. The same accounting applies to host control notifications: a host
whose control socket stops reading stops receiving new admissions (`503`) at `RELAY_MAX_QUEUE_MESSAGES`
unacknowledged notifications and is removed if closes push it past that cap.

## Deployment notes

- Bind to loopback by default. For the public internet put the relay behind a TLS-terminating reverse proxy
  and expose only `wss://`. The relay speaks plain HTTP/WS to the proxy.
- Behind a proxy, set `RELAY_TRUST_FORWARDED_FOR=true` so rate limiting sees client IPs instead of the proxy.
- Shutdown: on `SIGTERM` the relay stops admitting (`/healthz` returns 503), lets active pairs finish for up
  to 5 seconds, then closes remaining sockets with `1001` and exits 0.
- The relay is a single node with in-memory state. There is no socket migration and no delivery guarantee
  beyond what TCP and the WebSocket framing give while a pair is connected. Endpoints must handle reconnects
  and application-level acknowledgement themselves.

## Tests

`test.sh` runs:

- ExUnit: configuration parsing and validation, canonical Base64URL, endpoint ids, Ed25519 challenge
  verification, close code mapping, rate limiter burst/refill plus the source cap and eviction, and the
  registry's bounded control-notification accounting with a non-acknowledging host process.
- Node end-to-end tests against the release binary on ephemeral loopback ports (`clients/test/*.test.mjs`):
  registration, invalid signature, stolen claim, replay, reconnect, auth timeout; text/binary/empty payloads,
  order and boundaries, handshake-looking JSON; multiple hosts and clients without cross delivery, token
  misuse, stale generations; pending buffering, pair timeout, oversize, pending overflow, stalled reader with
  an independent healthy pair, admission limits, rate limiting, heartbeat cleanup for data and control
  sockets, abrupt disconnects, graceful and forced drain; close code/reason preservation; a one byte message
  limit with working control auth; TLS 1.3 over the relay with a pinned test certificate (encrypted
  request/response, wrong identity, tampered record, replayed record, fresh reconnect); and a JSON-RPC-style
  text protocol plus a binary tagged-field protocol over one relay.

Not covered end to end: the stalled-control-reader cap. Making a relay-side write block requires filling both
kernel socket buffers with tens of thousands of real connections, so that policy is exercised at the registry
level in ExUnit instead.

## Limitations

- A peer that is actively sending when the relay closes its socket may observe `1006` instead of the sent
  close frame, because the kernel resets a connection closed with unread inbound data. Idle peers receive the
  relay's close code.
- Rate limiting and admission counters are per node and in memory.
- Admission checks run before the upgrade and the pair is committed from the socket process after the
  upgrade. Two simultaneous accepts with the same token both pass the pre-check; the second is then closed
  with `1008` after the upgrade. The token is still consumed exactly once.
- The benchmark drivers are single-threaded Node processes and become the bottleneck at 64 KiB payloads with
  many clients; the numbers bound the relay from below.
