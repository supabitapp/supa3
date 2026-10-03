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

## Benchmark results

One measured full run on 2026-10-03 (run duration 4 min 16 s, 2000 ms warmup and 5000 ms measurement per case) through the shared-machine advisory lock, followed by no further runs. A shorter smoke matrix (500 ms warmup, 1500 ms measurement) produced results of the same shape. Numbers are from a shared, loaded workstation and are provisional.

Measured on Darwin 27.0.0 arm64, Apple M5 Max (18 cores), Erlang/OTP 29 [erts-17.1] [source] [64-bit] [smp:18:18] [ds:18:18:10] [async-threads:1] [jit] [dtrace], Elixir 1.20.4 (compiled with Erlang/OTP 29), Cowboy 2.19.0, Node v26.5.1, ws 8.22.0. Build: MIX_ENV=prod mix release (strip_beams, JIT enabled by default on this OTP). Load average at start 4.6, 5.5, 5.9, at end 3.7, 5.3, 5.8. Shared machine: results are provisional.

Workload: each client keeps 1 message in flight (send, wait for the echo, repeat), warmup 2000 ms discarded, then 5000 ms measured. Relay path is client -> relay -> echo host -> relay -> client; baseline is client -> Node ws echo server -> client with the same driver. RTT in milliseconds. Throughput counts completed round trips; payload MiB/s is one direction of application payload.

| Target | Payload | Clients | Rep | Samples | p50 | p95 | p99 | max | msg/s | payload MiB/s | establish p50/p99 ms | mismatches/timeouts/closes | relay CPU % | relay RSS MiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| relay | 64 B | 1 | 1 | 78050 | 0.057 | 0.101 | 0.174 | 5.84 | 15610 | 0.95 | 3.37/3.37 | 0/0/0 | 86 | 169 |
| relay | 64 B | 32 | 1 | 253311 | 0.625 | 0.725 | 0.785 | 6.13 | 50662 | 3.09 | 7.32/7.64 | 0/0/0 | 787 | 175 |
| relay | 64 B | 128 | 1 | 254192 | 2.476 | 2.805 | 2.982 | 7.55 | 50838 | 3.10 | 4.92/7.35 | 0/0/0 | 939 | 193 |
| relay | 1024 B | 1 | 1 | 79694 | 0.060 | 0.072 | 0.095 | 2.43 | 15939 | 15.57 | 1.77/1.77 | 0/0/0 | 87 | 167 |
| relay | 1024 B | 32 | 1 | 251148 | 0.626 | 0.742 | 0.993 | 3.61 | 50229 | 49.05 | 8.86/9.65 | 0/0/0 | 760 | 182 |
| relay | 1024 B | 32 | 2 | 253269 | 0.625 | 0.732 | 0.791 | 3.44 | 50654 | 49.47 | 8.01/8.36 | 0/0/0 | 765 | 182 |
| relay | 1024 B | 32 | 3 | 239569 | 0.652 | 0.786 | 0.886 | 8.86 | 47914 | 46.79 | 7.13/7.55 | 0/0/0 | 764 | 177 |
| relay | 1024 B | 128 | 1 | 216767 | 2.937 | 3.301 | 3.585 | 12.15 | 43354 | 42.34 | 5.42/7.48 | 0/0/0 | 1068 | 204 |
| relay | 65536 B | 1 | 1 | 14996 | 0.327 | 0.377 | 0.518 | 2.91 | 2999 | 187.46 | 1.85/1.85 | 0/0/0 | 56 | 166 |
| relay | 65536 B | 32 | 1 | 65262 | 2.196 | 4.257 | 5.062 | 8.21 | 13047 | 815.42 | 7.01/7.43 | 0/0/0 | 349 | 316 |
| relay | 65536 B | 128 | 1 | 67289 | 9.194 | 11.185 | 18.382 | 23.75 | 13443 | 840.20 | 5.53/7.35 | 0/0/0 | 437 | 440 |
| baseline | 64 B | 1 | 1 | 238373 | 0.020 | 0.027 | 0.033 | 1.05 | 47675 | 2.91 | 3.01/3.01 | 0/0/0 | - | - |
| baseline | 64 B | 32 | 1 | 778806 | 0.181 | 0.357 | 0.388 | 2.84 | 155761 | 9.51 | 5.26/5.83 | 0/0/0 | - | - |
| baseline | 64 B | 128 | 1 | 779949 | 0.768 | 1.419 | 1.598 | 5.11 | 156007 | 9.52 | 2.33/5.79 | 0/0/0 | - | - |
| baseline | 1024 B | 1 | 1 | 198395 | 0.024 | 0.030 | 0.039 | 4.78 | 39679 | 38.75 | 3.12/3.12 | 0/0/0 | - | - |
| baseline | 1024 B | 32 | 1 | 669461 | 0.211 | 0.420 | 0.542 | 5.86 | 133895 | 130.76 | 5.17/5.82 | 0/0/0 | - | - |
| baseline | 1024 B | 32 | 2 | 690119 | 0.208 | 0.412 | 0.435 | 1.35 | 138024 | 134.79 | 5.48/6.05 | 0/0/0 | - | - |
| baseline | 1024 B | 32 | 3 | 671341 | 0.210 | 0.419 | 0.548 | 5.65 | 134270 | 131.12 | 5.30/5.93 | 0/0/0 | - | - |
| baseline | 1024 B | 128 | 1 | 663901 | 0.898 | 1.489 | 1.885 | 5.28 | 132768 | 129.66 | 2.29/5.66 | 0/0/0 | - | - |
| baseline | 65536 B | 1 | 1 | 39353 | 0.115 | 0.144 | 0.352 | 1.08 | 7871 | 491.91 | 2.84/2.84 | 0/0/0 | - | - |
| baseline | 65536 B | 32 | 1 | 82027 | 1.806 | 2.891 | 3.855 | 5.48 | 16405 | 1025.33 | 5.55/6.18 | 0/0/0 | - | - |
| baseline | 65536 B | 128 | 1 | 78786 | 8.011 | 8.950 | 10.014 | 18.99 | 15744 | 984.01 | 2.72/5.98 | 0/0/0 | - | - |

Relay CPU is the BEAM process's CPU time during the case divided by wall time (warmup plus measurement), sampled with `ps`; RSS is the peak sample during the case.

Idle memory (5 hosts, RSS of the relay process, 2 s idle before each sample):

| Paired clients | RSS MiB | Note |
| --- | --- | --- |
| 0 | 163 | fresh start |
| 100 | 170 | connected in 23 ms |
| 500 | 206 | connected in 73 ms |
| 0 | 196 | after disconnecting all pairs |

Releasing all 500 pairs took 1423 ms until `/metrics` reported zero pairs. The BEAM keeps freed heap in its allocators, so RSS does not drop back to the starting value immediately.

Reconnect churn: 200 connect, pair, echo, close cycles at concurrency 10 completed in 0.05 s (4084 cycles/s) with 0 failures; cycle p50 2.23 ms, p99 4.58 ms; relay RSS 171 MiB before, 173 MiB after, 0.35 CPU seconds; all pairs released afterwards.

Slow reader isolation: a paused client was flooded with 64 KiB messages (142 sent, 9 MiB) until the relay closed that pair after 4003 ms (flooding sender observed close 1006). An independent 1 KiB echo pair measured concurrently: p50/p99 0.061/0.140 ms before, 0.061/0.084 ms during (max 7.44 ms), 0.061/0.087 ms after.

Connection attempts in the whole run: 2505; local port exhaustion events: 0; failed cases: 0.

Raw per-case JSON including every RTT sample: `/tmp/passio-relay-bench/elixir-r06-full` (outside the worktree).

Interpretation: the relay adds roughly 2 to 3 process hops and two extra WebSocket encode/decode passes per echo compared with the direct baseline, which shows up as 2 to 3 times the baseline RTT at low concurrency. Relay CPU above 100% reflects the BEAM spreading socket processes across schedulers; it is not a saturation figure, and the single-threaded Node drivers are the throughput limit at 64 KiB payloads. No message was lost, corrupted, or reordered in any case. These are measured results for this machine only and must not be extrapolated to other hardware or to the unmeasured capacity of a production deployment.
