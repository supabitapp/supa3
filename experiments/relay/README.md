# Passio relay (Go)

A single-node WebSocket relay that pairs a registered host endpoint with
clients and forwards opaque text and binary messages between them. The relay
never inspects, interprets, or alters application payloads. Encryption and
authorization between the endpoints are the endpoints' job; this relay only
authenticates the host that claims an endpoint and hands out one-time pairing
tokens.

Everything lives in this directory. It has its own `go.mod` and does not touch
the workspace manifests.

## Commands

All commands run from `experiments/relay/`.

```sh
./build.sh                      # release build into bin/relay and bin/bench
./run.sh                        # run bin/relay with RELAY_* from the environment
./test.sh                       # gofmt, go vet, go test -race (real sockets)
./bench.sh                      # full benchmark; prints JSON, raw data under /tmp
./bench.sh -quick               # short smoke benchmark
./bench.sh -only relay,memory   # subset: relay,direct,pipelined,memory,slow
```

On a shared machine take the advisory lock first:

```sh
python3 /tmp/passio-relay-benchmark-lock.py -- bash experiments/relay/bench.sh
```

Raw benchmark data goes to `RELAY_BENCH_OUT` or
`/tmp/passio-relay-bench/<timestamp>/` (never into the worktree). The relay
prints one JSON line to stdout on startup, for example
`{"event":"listening","address":"127.0.0.1:8080"}`. All other logs are JSON on
stderr.

## Protocol

Base64URL values are canonical and unpadded. `endpointId` is lowercase hex
SHA-256 of the raw 32-byte Ed25519 host public key.

| Endpoint | Who | Behaviour |
| --- | --- | --- |
| `GET /healthz` | anyone | `200 {"status":"ok"}`, `503` while draining |
| `GET /metrics` | anyone | JSON counters, see below |
| `GET /v1/control?publicKey=B64` | host | challenge/response registration, then control events |
| `GET /v1/connect?endpointId=HEX` | client | admitted as a pending pair; `404` if no host |
| `GET /v1/accept?endpointId=HEX&connectionId=ID&token=TOKEN` | host | claims one pending pair |

Host registration on the control socket:

1. Relay sends `{"type":"challenge","nonce":"B64(32 random bytes)"}`.
2. Host replies `{"type":"authenticate","signature":"B64(ed25519 sig)"}` where
   the signed bytes are `"passio-relay-v1\n" + endpointId + "\n" + nonce`.
3. Relay sends `{"type":"registered","endpointId":"HEX"}`.

The nonce is bound to that socket and single use. Invalid or missing
signatures, replayed signatures, a second `authenticate`, any other message
after registration, and authentication slower than `RELAY_AUTH_TIMEOUT_MS`
close the socket with `1008`. A non-canonical or wrong-length `publicKey` is
rejected with HTTP `400` before upgrade. Registering an endpoint that already
has an active host closes the new socket with `1008` and leaves the existing
host untouched; after the old control socket is gone the host may register
again.

Client admission: `/v1/connect` is rejected before upgrade with `404` when no
host is registered, `503` when a limit is hit or the relay is draining, and
`429` when the per-IP admission rate is exceeded. On admission the relay sends
the host `{"type":"incoming","connectionId":"B64(16)","token":"B64(32)"}`. The
client socket receives no relay JSON; everything on it is application data.

Pairing: the host opens `/v1/accept` with that token. The token is valid only
for that pending pair in that host registration. Wrong, missing, non-canonical,
or reused tokens are rejected with `403`; unknown, expired, closed, or
previous-generation pairs with `404`. Both rejections happen before upgrade.

Forwarding: once paired, every complete text or binary message is forwarded in
order with its type and contents intact. Messages a client sends before the
host accepts are buffered within the per-direction queue limits and drained in
order after pairing. The pending pair is closed with `1013` after
`RELAY_PAIR_TIMEOUT_MS` without an accept.

Closing: when either data socket closes, the relay closes the other with the
same code and reason when that code is legal to send (1000, 1001, 1002, 1003,
1007 to 1011, 3000 to 4999) and otherwise with `1011`. Limit violations use
`1009` (message too big) or `1013` (queue full, slow consumer, pair timeout).
The host control socket gets `{"type":"closed","connectionId":"..."}` once per
released pair. Closing the control socket closes all of that host's pending and
active pairs with `1001`.

Liveness: the relay pings every socket every `RELAY_HEARTBEAT_MS` and closes a
socket that has not answered any ping for `2 * RELAY_HEARTBEAT_MS`. Every write
has a `RELAY_WRITE_TIMEOUT_MS` deadline. A peer that stalls is closed with
`1013` once its outbound queue fills or a write times out; other pairs are not
affected because each pair owns its own goroutines and queues.

Drain: on `SIGTERM` or `SIGINT` the relay stops admitting control and connect
requests (`503`), keeps `/healthz` answering `503`, lets existing pairs
continue (hosts may still accept already-admitted clients), and exits once no
pairs remain or after 5 seconds, closing leftovers with `1001`.

### Metrics

`/metrics` returns `activeHosts`, `controlSockets`, `activePairs`, `pendingPairs`,
`forwardedMessages`, `forwardedBytes`, `rejectedConnections`, and `draining`.
Payloads, tokens, nonces, signatures, and keys are never exposed or logged.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_ADDR` | `127.0.0.1:8080` | Listen address. Port `0` picks a free port; the actual address is printed. |
| `RELAY_MAX_MESSAGE_BYTES` | `1048576` | Largest accepted message on data sockets. Control sockets have a fixed 4096-byte cap. |
| `RELAY_MAX_QUEUE_BYTES` | `4194304` | Bytes queued per data direction, including pre-pairing buffered messages. Must be at least the message limit. |
| `RELAY_MAX_QUEUE_MESSAGES` | `256` | Messages queued per data direction. |
| `RELAY_MAX_CLIENTS` | `1024` | Global pending plus active pairs. |
| `RELAY_MAX_HOSTS` | `1024` | Concurrent control sockets, counted from upgrade until close, so unauthenticated sockets waiting on the challenge count too. Over the cap `/v1/control` answers `503` before upgrade. |
| `RELAY_MAX_CLIENTS_PER_HOST` | `128` | Pending plus active pairs per host. |
| `RELAY_MAX_PENDING_PER_HOST` | `32` | Unaccepted pairs per host. Must not exceed the per-host client limit. |
| `RELAY_AUTH_TIMEOUT_MS` | `5000` | Time a host has to answer the challenge. |
| `RELAY_PAIR_TIMEOUT_MS` | `5000` | Time a host has to accept an admitted client. |
| `RELAY_WRITE_TIMEOUT_MS` | `5000` | Deadline for every socket write, including pings and close frames. |
| `RELAY_HEARTBEAT_MS` | `15000` | Ping interval. A socket silent for two intervals is closed. |
| `RELAY_ADMISSION_RATE` | `100` | Upgrade attempts per second per IP, burst of twice the rate. Buckets expire once full again and the table is capped at 65536 addresses. |
| `RELAY_TRUST_FORWARDED_FOR` | `false` | Use the last `X-Forwarded-For` entry as the client IP. Enable only behind a proxy that overwrites that header. |

Every value is validated at startup; an invalid value exits with status 2 and
a message naming the variable.

## Deployment notes

The relay speaks plain HTTP and `ws://` and binds loopback by default. A public
deployment must sit behind a TLS-terminating reverse proxy so endpoints use
`wss://`; the relay itself does not terminate TLS. The proxy must forward
WebSocket upgrades and should not buffer responses. Set
`RELAY_TRUST_FORWARDED_FOR=true` only when the proxy is the sole source of
traffic.

The relay does not provide socket migration or exactly-once delivery. A pair
is a single pair of TCP connections; when either side drops, the pair is gone
and the application must reconnect and recover its own state.

## Tests

`./test.sh` builds the release binary, then runs `go vet` and the suite under
the race detector. Every test drives a real listening relay through real
WebSocket connections; shutdown tests spawn the built binary and send
`SIGTERM`. Coverage:

- registration, invalid and padded signatures, non-canonical keys, stolen
  endpoint claims, challenge replay on the same and on a new socket,
  authentication timeout, legitimate reconnect
- text, binary, empty, large, unicode and handshake-looking JSON payloads in
  both directions, with 500-message ordering and boundary checks
- multiple hosts with simultaneous clients and no cross delivery; wrong,
  missing, padded, reused, cross-host and stale-generation tokens
- pending buffering and drain order, queue byte and message limits, pair
  timeout, oversize messages, slow and stalled readers with a healthy pair
  checked alongside, connection limits, admission rate limiting, heartbeat
  cleanup, abrupt TCP resets, close-code propagation, single closed
  notification, control socket teardown
- graceful drain letting an active pair finish, and forced close after the
  5 second drain window
- an end-to-end TLS 1.3 session between two test endpoints over a WebSocket
  byte stream through the relay, with the client pinning the host certificate:
  request/response, wrong host certificate rejected, flipped ciphertext byte
  rejected, replayed record rejected, fresh reconnect
- JSON-RPC text and a length-prefixed binary format through one relay

This directory is Go only, so the Elixir checks mentioned in the task brief do
not apply. Not covered by automated tests: behaviour behind an actual reverse
proxy, and heartbeat behaviour against a proxy that drops ping frames.

## Benchmarks

`bench.sh` spawns the built relay with raised limits, drives it with Go
clients, and prints a JSON report. Per case it reports echo RTT p50/p95/p99,
messages per second, payload MiB/s, connection establishment latency,
failures, timeouts, corruptions (sequence and length checks), relay CPU
percent, and relay RSS sampled with `ps`. Warmup samples are discarded. The
main 1 KiB / 32 client case repeats three times. A direct WebSocket echo server
driven by the same loop is the baseline. Memory is sampled idle at 0, 100 and
500 pairs, after disconnect, and after a reconnect churn of 2000 pairings with
32 in flight. The slow-reader case floods a stalled host while an independent
pair is measured.

Results are provisional on a shared machine; see the final report in the task
thread for one measured run and its raw data path.

## Limitations

- Single node. No cross-node routing, no persistence, no session resumption.
- Each forwarded message is copied once into a queue; a direct write path for
  idle queues would raise throughput at the cost of simpler slow-consumer
  semantics.
- Per-IP limiting keys on the TCP peer unless `RELAY_TRUST_FORWARDED_FOR` is
  set, so all traffic through one proxy shares a bucket by default.
- Origin checks are disabled; browser clients from any origin may connect, so
  endpoints must not rely on the relay for authorization.
