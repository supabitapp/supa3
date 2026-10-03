# Passio relay (Elixir)

A standalone, single-node WebSocket relay. Hosts authenticate with an Ed25519 key, clients connect to a host by endpoint id, and the relay pairs one client socket with one host data socket and forwards every complete text or binary message unchanged in both directions. The relay never parses application payloads: messages named `hello`, `e2ee_hello`, or anything that looks like relay JSON are opaque bytes. Encryption and authorization between endpoints belong to the endpoint applications.

Built on Cowboy/Ranch (HTTP and WebSocket) and Erlang `:crypto` (Ed25519, SHA-256, CSPRNG). No T3 code or contracts are imported.

## Commands

All scripts run from any directory and keep Mix/Hex state, dependencies, build output, and `node_modules` inside this directory (gitignored).

```bash
bash experiments/relay/build.sh    # MIX_ENV=prod release + npm ci for test/bench clients
bash experiments/relay/run.sh      # runs the built release, no rebuild; reads RELAY_* env
bash experiments/relay/test.sh     # build, mix format check, warnings-as-errors compile, ExUnit, Node end-to-end suite
python3 /tmp/passio-relay-benchmark-lock.py -- bash experiments/relay/bench.sh   # JSON results on stdout
```

Requirements: Erlang/OTP and Elixir (`/opt/homebrew/bin` is put first on `PATH`), Node 22+ with npm, and `openssl` on `PATH` for the TLS fixture.

`bench.sh` honours `BENCH_OUT` (raw JSON directory, default a fresh `$TMPDIR/passio-relay-bench-*`), `BENCH_WARMUP_MS` (2000), `BENCH_MEASURE_MS` (5000), `BENCH_INFLIGHT` (1), `BENCH_CHURN_CYCLES` (1000, capped at 2000), `BENCH_SECTIONS` (`matrix,memory,slow`) and `BENCH_ONLY` (comma-separated run ids such as `relay-1024B-32c-r2`, for rerunning individual cases). A run aborts immediately with `"portExhausted": true` if the local machine runs out of ephemeral ports.

## Protocol

All Base64URL values are canonical and unpadded. `endpointId` is the lowercase hex SHA-256 of the raw 32-byte Ed25519 public key.

| Request | Behaviour |
| --- | --- |
| `GET /healthz` | `200 {"status":"ok"}`; `503 {"status":"draining"}` during drain |
| `GET /metrics` | JSON counters: `activeHosts`, `activePairs`, `pendingPairs`, `forwardedMessages`, `forwardedBytes`, `rejectedConnections`, `draining`. No payloads, keys, tokens, or signatures. |
| `GET /v1/control?publicKey=B64URL` | Host control socket. Malformed or noncanonical keys get `400` before upgrade. |
| `GET /v1/connect?endpointId=HEX` | Client data socket. `404` before upgrade when no host is registered, `503` at a connection limit, `400` for a malformed id. |
| `GET /v1/accept?endpointId=HEX&connectionId=ID&token=TOKEN` | Host data socket for one pending pair. Unknown pair, other endpoint, or stale host generation → `404`; wrong, missing, or reused token → `403`. |

Every upgrade endpoint returns `429` when the per-IP admission rate is exceeded and `503` while draining.

Control socket:

1. Relay → host: `{"type":"challenge","nonce":"<32 random bytes>"}`
2. Host → relay: `{"type":"authenticate","signature":"<Ed25519 signature>"}` over the UTF-8 bytes `"passio-relay-v1\n" + endpointId + "\n" + nonce`.
3. Relay → host: `{"type":"registered","endpointId":"<hex>"}`. A bad or missing signature, any other first message, or no reply within `RELAY_AUTH_TIMEOUT_MS` closes with `1008`. The nonce is per socket and consumed by the first reply. If the endpoint is already registered, the new socket is closed with `1008 endpoint already registered` and the existing host keeps working.
4. Relay → host: `{"type":"incoming","connectionId":"<16 bytes>","token":"<32 bytes>"}` for each admitted client, and `{"type":"closed","connectionId":"..."}` once when a pair the host was told about is released. Any further frame from the host closes the control socket with `1008`.

Data sockets carry only application messages. Client messages sent before the host accepts are buffered (within the queue limits) and delivered in order after pairing.

Close behaviour:

| Situation | Code delivered |
| --- | --- |
| Peer closed with a legal code (1000–1003, 1007–1014, 3000–4999) | same code and reason |
| Peer closed without a code | 1000 |
| Peer vanished (TCP reset, write timeout, crash) | 1011 `peer connection lost` |
| Missed heartbeat | 1011 `heartbeat timeout` |
| Message over `RELAY_MAX_MESSAGE_BYTES` | 1009 |
| Direction queue over its byte or message limit | 1013 `queue limit exceeded` |
| Host did not accept within `RELAY_PAIR_TIMEOUT_MS` | 1013 `pair timeout` |
| Host control socket closed | 1001 `host disconnected` (all pending and active pairs) |
| Host control socket fell behind on notifications | 1013 `control queue limit exceeded`, host unregistered |
| Drain | 1001 |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_ADDR` | `127.0.0.1:8080` | `HOST:PORT` (IPv4, `[IPv6]`, or a resolvable name). Port `0` picks a free port. |
| `RELAY_MAX_MESSAGE_BYTES` | 1048576 | Largest message, including reassembled fragments |
| `RELAY_MAX_QUEUE_BYTES` | 4194304 | Bytes queued per data direction (pre-pair buffer plus undelivered messages); also bounds undelivered control notifications per host |
| `RELAY_MAX_QUEUE_MESSAGES` | 256 | Messages queued per data direction |
| `RELAY_MAX_CLIENTS` | 1024 | Global pending plus active pairs |
| `RELAY_MAX_CLIENTS_PER_HOST` | 128 | Pending plus active pairs per host |
| `RELAY_MAX_PENDING_PER_HOST` | 32 | Unaccepted pairs per host |
| `RELAY_AUTH_TIMEOUT_MS` | 5000 | Time to answer the challenge |
| `RELAY_PAIR_TIMEOUT_MS` | 5000 | Time for the host to accept an incoming client |
| `RELAY_WRITE_TIMEOUT_MS` | 5000 | Socket send deadline; a blocked write closes that socket |
| `RELAY_HEARTBEAT_MS` | 15000 | Relay ping interval. A socket that has not answered the previous ping when the next one is due is closed, so a dead peer is detected within 2 × this value. |
| `RELAY_ADMISSION_RATE` | 100 | Upgrade attempts per second per client IP, token bucket with a burst of 2 × rate. Buckets are swept every 10 s once refilled and capped at 100000 tracked IPs; new IPs are refused while the table is full. |
| `RELAY_TRUST_PROXY` | 0 | `1` uses the right-most `X-Forwarded-For` address for rate limiting. Only enable it behind a proxy that sets that header. |

Integer values must be positive whole numbers. The message limit must not exceed the queue byte limit, the per-host limit must not exceed the global one, and the pending limit must not exceed the per-host one. Invalid configuration prints the variable to stderr and exits with status 2.

On startup the relay prints exactly one stdout line, `{"event":"listening","address":"127.0.0.1:PORT"}`. Everything else goes to stderr. Request URLs, tokens, and keys are never logged.

SIGTERM starts a drain: health turns `503`, new control, connect, and accept requests are refused, pending pairs close with `1001`, active pairs may finish for up to 5 seconds, then every remaining socket is closed with `1001` and the process exits 0.

## Deployment

The relay speaks plain WS and binds loopback by default. Any public deployment must sit behind a TLS-terminating reverse proxy so clients use `wss://`; the `token` and `connectionId` in `/v1/accept` URLs are bearer credentials and must never cross the network in clear text, and proxy access logs must not record query strings. Forward the `Upgrade`/`Connection` headers, set proxy read timeouts above `2 × RELAY_HEARTBEAT_MS`, and set `RELAY_TRUST_PROXY=1` so rate limiting sees client addresses. Ranch accepts up to `2 × RELAY_MAX_CLIENTS + 4096` sockets; raise the process file descriptor limit accordingly.

## Tests

`test.sh` runs ExUnit (configuration validation, canonical Base64URL, signature message, close-code mapping, rate-limit bookkeeping, Hub notification accounting) and then the Node suite in `clients/test`, which starts the built release on an ephemeral loopback port and drives it with real WebSockets:

- `registration`: valid registration, invalid/missing/forged signatures, noncanonical keys, auth timeout, challenge replay across sockets, nonce reuse within a socket, stolen endpoint claim while the owner stays usable, legitimate re-registration.
- `forwarding`: text, random binary, and empty payloads both ways; exact size limit; 500-message order and type preservation; handshake-like JSON passed through; no relay records on client sockets; 1009 oversize; close code and reason propagation; abrupt disconnects; `closed` delivered exactly once.
- `isolation`: three hosts with five simultaneous clients each and no cross-delivery; wrong, missing, reused, and cross-endpoint tokens; host control close tearing down pending and active pairs; stale-generation tokens after re-registration.
- `limits`: pre-pair buffering order, pre-pair message and byte overflow, pair timeout, stalled reader isolated by the queue limit, write timeout, heartbeat keep-alive and cleanup for data and control sockets, connection limits, per-IP rate limiting, control-notification accounting under bounded churn.
- `shutdown`: SIGTERM with live traffic, refused admissions, prompt exit once pairs finish, forced close after the 5 second grace.
- `tls`: TLS 1.3 between two test endpoints over relay data sockets, with the client pinning a throwaway host certificate. Covers encrypted request/response, the relay carrying only ciphertext, rejection of the wrong host identity, rejection of modified ciphertext, rejection of a replayed record, and a fresh session afterwards. Certificates are generated with `openssl` into a temp directory and deleted afterwards.
- `formats`: JSON-RPC text and a length-prefixed binary TLV protocol through the same relay.
- `startup`: listening line with port 0, invalid configuration exit.

Not exercised end to end:

- Eviction of a stalled control socket. Reaching it through real sockets takes thousands of connections, because kernel buffers absorb notifications first. Hub unit tests cover the accounting and eviction; the end-to-end test only shows that a reading host is not evicted under bounded churn.
- The 100000-entry rate-limit table cap.
- IPv6 listening.
- `RELAY_TRUST_PROXY` behind a real proxy.

## Limitations

- Single node, in-memory state. A restart drops every registration and pair; there is no socket migration and no message replay, so applications own reconnection and exactly-once semantics.
- Queue overflow closes the pair rather than applying backpressure to the sender.
- Message limits are enforced after Cowboy reassembles a message, so one connection can hold up to `RELAY_MAX_MESSAGE_BYTES` in memory before rejection.
- A relay-initiated close lingers up to 1 s, draining unread input so the peer receives the close frame instead of a TCP reset.
- The release disables BEAM scheduler busy-waiting (`rel/vm.args.eex`: `+sbwt none +sbwtdcpu none +sbwtdio none`) to avoid burning idle CPU on shared machines. That trades a little latency for CPU.
- Admission (registration, connect, accept) runs through one Hub process. Message forwarding is process to process and does not touch it.
- cowlib 2.20.0 carries two advisories (structured-header escaping and the cookie encoder). The relay calls neither code path; it is the latest release.

## Benchmark results (provisional, shared machine)

One full `bench.sh` run on 2026-10-03, holding the shared benchmark lock. Machine: Apple M5 Max, 18 cores, 128 GiB, macOS 27.0, arm64. Software: Erlang/OTP 29 (ERTS 17.1, JIT), Elixir 1.20.4, Cowboy 2.19.0, Ranch 2.3.0, Node v26.5.1, ws 8.22.0. Build: `MIX_ENV=prod mix release`, default scheduler count, busy-wait disabled, no compression. The bench relay raised `RELAY_MAX_CLIENTS=2048`, `RELAY_MAX_CLIENTS_PER_HOST=512`, `RELAY_MAX_PENDING_PER_HOST=512`, and `RELAY_ADMISSION_RATE=100000`, since every client comes from one loopback IP; all other settings were defaults. Other agents were using the machine at the same time, so treat these numbers as provisional.

Workload: closed-loop echo with 1 message in flight per client and binary payloads. A 2 s warmup is excluded; the measurement window is 5 s. Clients are spread over 4 worker threads. Echo endpoints are Node `ws` processes, one per 32 clients up to 4. In relay mode they are hosts behind the relay; in direct mode they are plain WebSocket servers driven by the same load generator. Every echo is compared byte for byte with what was sent. Connect latency runs from socket creation until the first echo returns, which includes the host accept. CPU and RSS are sampled from the relay process (or the direct servers) during the measurement window. Raw per-run JSON with latency histograms is in `/tmp/passio-relay-bench-r04-full/`.

| Run | RTT p50 / p95 / p99 ms (samples) | echoes/s | echo MiB/s | connect p50 / p99 ms | CPU % | RSS max MiB |
| --- | --- | --- | --- | --- | --- | --- |
| relay 64 B × 1 | 0.046 / 0.055 / 0.063 (106105) | 21221 | 1.3 | 3.8 / 3.8 | 44 | 175 |
| direct 64 B × 1 | 0.020 / 0.027 / 0.035 (237992) | 47598 | 2.9 | 4.5 / 4.5 | 44 | 65 |
| relay 64 B × 32 | 0.509 / 0.622 / 0.693 (310740) | 62148 | 3.8 | 7.8 / 9.7 | 437 | 184 |
| direct 64 B × 32 | 0.184 / 0.365 / 0.408 (770707) | 154141 | 9.4 | 5.2 / 8.3 | 100 | 81 |
| relay 64 B × 128 | 2.506 / 2.957 / 3.193 (252388) | 50478 | 3.1 | 15.0 / 16.3 | 532 | 195 |
| direct 64 B × 128 | 0.795 / 1.039 / 1.248 (774702) | 154940 | 9.5 | 7.7 / 10.4 | 201 | 268 |
| relay 1 KiB × 1 | 0.057 / 0.069 / 0.079 (85507) | 17101 | 16.7 | 3.6 / 3.6 | 54 | 175 |
| direct 1 KiB × 1 | 0.022 / 0.030 / 0.035 (210085) | 42017 | 41.0 | 4.8 / 4.8 | 45 | 65 |
| relay 1 KiB × 32, rep 1 | 0.730 / 0.911 / 1.002 (216777) | 43355 | 42.3 | 8.3 / 10.0 | 610 | 189 |
| relay 1 KiB × 32, rep 2 | 0.733 / 0.922 / 1.018 (215568) | 43114 | 42.1 | 7.4 / 8.9 | 604 | 190 |
| relay 1 KiB × 32, rep 3 | 0.728 / 0.909 / 1.004 (217285) | 43457 | 42.4 | 7.8 / 9.5 | 621 | 189 |
| direct 1 KiB × 32, rep 1 | 0.208 / 0.415 / 0.464 (684572) | 136914 | 133.7 | 5.2 / 7.3 | 100 | 84 |
| direct 1 KiB × 32, rep 2 | 0.215 / 0.430 / 0.500 (661115) | 132223 | 129.1 | 5.0 / 6.7 | 100 | 83 |
| direct 1 KiB × 32, rep 3 | 0.241 / 0.548 / 0.743 (539795) | 107959 | 105.4 | 5.2 / 7.1 | 99 | 75 |
| relay 1 KiB × 128 | 3.229 / 3.838 / 4.259 (197317) | 39463 | 38.5 | 18.7 / 22.4 | 1030 | 213 |
| direct 1 KiB × 128 | 0.816 / 1.217 / 1.515 (732235) | 146447 | 143.0 | 9.1 / 11.9 | 210 | 275 |
| relay 64 KiB × 1 | 0.278 / 0.304 / 0.377 (17540) | 3508 | 219.3 | 3.7 / 3.7 | 36 | 175 |
| direct 64 KiB × 1 | 0.123 / 0.162 / 0.240 (37240) | 7448 | 465.5 | 4.7 / 4.7 | 37 | 143 |
| relay 64 KiB × 32 | 1.811 / 3.668 / 4.166 (71704) | 14341 | 896.3 | 7.5 / 9.2 | 266 | 267 |
| direct 64 KiB × 32 | 1.362 / 2.677 / 3.115 (104887) | 20977 | 1311.1 | 5.1 / 6.9 | 110 | 174 |
| relay 64 KiB × 128 | 9.125 / 10.105 / 10.765 (69605) | 13921 | 870.1 | 13.2 / 15.1 | 534 | 396 |
| direct 64 KiB × 128 | 4.337 / 5.073 / 5.705 (144346) | 28869 | 1804.3 | 8.1 / 10.7 | 303 | 766 |

Every run had 0 failed connects, 0 echo timeouts, and 0 corrupted echoes. The relay path adds a second hop through a Node echo host, so it costs one extra WebSocket parse and serialize on each side compared with direct. The relay's CPU use at 32 and 128 clients is the main cost seen here.

Memory and churn, with 5 hosts on one relay:

| Paired clients | Relay RSS (median of 5 samples after 2 s settle) |
| --- | --- |
| 0 | 171.5 MiB |
| 100 | 171.2 MiB |
| 500 | 184.6 MiB |
| after closing all 500 | 177.3 MiB; every pair released 35.8 ms after the closes were sent |

The baseline is mostly BEAM allocator reservation across 18 schedulers; 500 idle pairs (1000 sockets) added about 13 MiB. Reconnect churn ran 1000 connect → echo → close cycles at concurrency 16: 5643 cycles/s, cycle latency p50 2.5 ms and p99 9.3 ms, 0 failures, relay RSS 166.6 MiB afterwards, and metrics back to 0 pending and 0 active pairs.

Slow-reader isolation: one client stopped reading while its host flooded 64 KiB messages. The relay closed that pair with `1013 queue limit exceeded` 10.2 ms into the flood, after 80 messages. That is the 4 MiB / 256-message default queue plus socket buffers. An independent 1 KiB pair measured over 5 s showed RTT p50/p95/p99 of 0.057/0.068/0.077 ms before the flood and 0.057/0.067/0.075 ms during it, at about 17k echoes/s both times. Because the stalled pair is cut off so quickly, the flood itself is short.

Benchmark limitations: these are loopback measurements, with the load generator, echo endpoints, and relay all on one shared host. The load generator and Node echo hosts share the same CPUs, and RTT is measured in JavaScript. There is a single full run, except for the three repetitions of the main case. No capacity beyond the measured client counts is implied.
