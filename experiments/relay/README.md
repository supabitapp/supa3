# Passio relay

Passio forwards opaque, complete WebSocket messages between endpoint applications. The standalone Go server lives in [cmd/relay](cmd/relay/main.go); its only external dependency is [Gorilla WebSocket v1.5.3](https://pkg.go.dev/github.com/gorilla/websocket@v1.5.3). Endpoint applications own authorization and encryption.

## Build and run

Run these commands from the repository root with Go 1.27.1 available:

```bash
bash experiments/relay/build.sh
RELAY_ADDR=127.0.0.1:0 bash experiments/relay/run.sh
bash experiments/relay/test.sh
python3 /tmp/passio-relay-benchmark-lock.py -- bash experiments/relay/bench.sh
```

The build produces stripped, optimized `bin/relay`, `bin/client`, and `bin/bench` executables using `-trimpath -ldflags='-s -w'`. `run.sh` and `bench.sh` never rebuild. Dependencies remain in this Go module and the normal Go module cache. Binaries are ignored.

Startup writes one JSON line to stdout: `{"event":"listening","address":"127.0.0.1:ACTUAL_PORT"}`. Other server logging goes to stderr. Port zero selects an ephemeral port. SIGTERM and SIGINT stop admissions, release pending pairs, and let active pairs finish for at most five seconds. Remaining sockets then close; HTTP shutdown has a further 300 ms bound.

For a manual echo test, use the actual address from startup in two terminals:

```bash
experiments/relay/bin/client -mode echo-host -address 127.0.0.1:ACTUAL_PORT
experiments/relay/bin/client -address 127.0.0.1:ACTUAL_PORT -endpoint-id HEX -payload '{"type":"hello"}'
```

Copy `HEX` from the echo host's registration output. This fixture generates its host key in memory, echoes text or binary messages, and performs no application authorization. The requesting fixture verifies the echo and prints only its byte count. The tests and benchmark driver also run independent host/client endpoints.

## Wire protocol

All routes use GET. Base64URL values are canonical and unpadded. `endpointId` is the lowercase hexadecimal SHA-256 of the raw 32-byte Ed25519 public key.

1. Open `/v1/control?publicKey=BASE64URL_PUBLIC_KEY`. The relay sends text JSON `{"type":"challenge","nonce":"BASE64URL_32_RANDOM_BYTES"}`.
2. Sign the UTF-8 bytes `"passio-relay-v1\n" + endpointId + "\n" + nonce`, with no trailing newline. Reply with `{"type":"authenticate","signature":"BASE64URL_ED25519_SIGNATURE"}`.
3. Success returns `{"type":"registered","endpointId":"HEX"}`. Each challenge belongs to its socket, expires at the authentication deadline, and can be used once. An active endpoint rejects a second registration with close code 1008 while retaining the original host. Registration can resume after that host closes and is cleaned up.
4. A client opens `/v1/connect?endpointId=HEX`. An unknown endpoint returns HTTP 404 before upgrade. The relay allocates a random 16-byte connection ID and a random 32-byte token. The host receives `{"type":"incoming","connectionId":"ID","token":"TOKEN"}` on its control socket.
5. The host opens `/v1/accept?endpointId=HEX&connectionId=ID&token=TOKEN`. The token admits one pending pair in that host registration. Wrong, missing, expired, reused, or stale tokens return HTTP 403 before upgrade. Tokens cannot cross endpoints.
6. Both data sockets forward text and binary messages with their contents, boundaries, and order intact. Empty messages and payloads named `hello` or `e2ee_hello` follow the same path. Client data sockets receive no relay JSON records. Pending client messages use the same bounded queue as paired traffic and drain in order.
7. Closing either data socket releases the pair and closes its peer. The relay preserves legal close codes and reasons where possible; abnormal loss maps to 1011. The host receives `{"type":"closed","connectionId":"ID"}` at most once while its control socket remains available. Closing control releases every pair owned by that registration.

`/healthz` returns HTTP 200 and `{"status":"ok"}` while accepting traffic, and HTTP 503 during drain. `/metrics` returns numeric `activeHosts`, `activePairs`, `pendingPairs`, `forwardedMessages`, `forwardedBytes`, and `rejectedConnections`. Forwarded counts include successful data writes in both directions; control records are excluded. Metrics and server logs contain no application payloads, signatures, tokens, or private keys.

Malformed public keys or endpoint IDs return HTTP 400. Capacity and drain refusals return 503; admission rate refusals return 429. Invalid authentication and unexpected control messages close with 1008. Oversize data closes with 1009, queue exhaustion and pair expiry with 1013, and invalid UTF-8 text with 1007.

## Configuration

Empty, nonnumeric, nonpositive, and out-of-range numeric settings fail startup. Address ports accept 0 through 65535; the host must be nonempty. Byte and count ceilings below are per setting, not a promise of available machine memory.

| Variable | Default | Usage and accepted range |
| --- | ---: | --- |
| `RELAY_ADDR` | `127.0.0.1:8080` | Listen host and port; port 0 prints the selected port. Use `[::1]:0` for IPv6. |
| `RELAY_MAX_MESSAGE_BYTES` | 1048576 | Maximum complete data message; 1 through 67108864 bytes. |
| `RELAY_MAX_QUEUE_BYTES` | 4194304 | Payload bytes per data direction, including a write in progress; 1 through 268435456. |
| `RELAY_MAX_QUEUE_MESSAGES` | 256 | Messages per data direction, including empty messages and a write in progress; 1 through 65536. |
| `RELAY_MAX_CLIENTS` | 1024 | Global pending plus active pairs; 1 through 100000. Also bounds control sockets, including authentication in progress. |
| `RELAY_MAX_CLIENTS_PER_HOST` | 128 | Pending plus active pairs per host; 1 through 100000. |
| `RELAY_MAX_PENDING_PER_HOST` | 32 | Pending pairs per host; 1 through 100000. |
| `RELAY_AUTH_TIMEOUT_MS` | 5000 | Time to answer the socket's challenge; 1 through 3600000 ms. Pongs cannot extend it. |
| `RELAY_PAIR_TIMEOUT_MS` | 5000 | Time from pair reservation to host acceptance; 1 through 3600000 ms. |
| `RELAY_WRITE_TIMEOUT_MS` | 5000 | Deadline for each data write and WebSocket upgrade; 1 through 3600000 ms. |
| `RELAY_HEARTBEAT_MS` | 15000 | Relay ping interval; 1 through 3600000 ms. No pong for three intervals closes the connection. |
| `RELAY_ADMISSION_RATE` | 100 | Attempts per second per TCP peer IP; 1 through 1000000. The token bucket burst equals this value. |

The admission table holds at most 4096 IPs. Entries expire after 60 seconds without attempts; admission lazily sweeps expired entries at most once per second. A full table rejects new IPs. The TCP connection cap is `3 * RELAY_MAX_CLIENTS + 64`, including HTTP and unauthenticated connections. Excess TCP connections close before HTTP handling and are excluded from the HTTP rejection metric.

Control output has a separate 64 KiB/256-record queue and a 4 KiB incoming message limit. Every data direction has an independent writer and queue. Queue accounting covers payload lengths; receive buffers, queue slots, goroutine stacks, socket buffers, and allocator overhead consume additional memory. Each reader can hold one maximum-sized message outside its destination queue. A slow consumer can lose its pair, and a stalled control consumer can lose its whole host registration.

## Public operation

Public deployments require WSS through a TLS-terminating reverse proxy. Forward WebSocket upgrades for `/v1/`, preserve query parameters, and allow idle intervals beyond the heartbeat timeout. Keep the backend on loopback or a private interface. Disable or redact query strings in proxy access logs because acceptance URLs contain bearer tokens.

Admission uses the TCP peer address and ignores forwarded IP headers. A proxy therefore shares one rate bucket unless it provides separate network peer addresses. Configure public admission protection at that proxy. Restrict public access to `/metrics` if operational counts should remain private. Origins are accepted because the relay has no cookie authority; endpoints must authenticate and authorize application access.

## Correctness evidence

`test.sh` checks formatting, runs `go vet`, builds a race-instrumented server, and runs Go tests with the race detector. The [integration suite](integration/relay_test.go) launches that executable on ephemeral loopback ports and uses real host/client sockets. It covers:

- Valid registration, invalid and missing signatures, stolen identity claims, duplicate registration, challenge replay, repeated authentication, authentication expiry, canonical public keys, and legitimate reconnect.
- Bidirectional text, arbitrary binary, empty messages, fragmentation through the WebSocket library, exact order and boundaries, and unchanged JSON/XML application payloads.
- Simultaneous clients across hosts, wrong/missing/reused/expired/cross-host tokens, stale registration cleanup, and single close notification.
- Pending buffering, byte and message queue limits, pair timeouts, oversize traffic from either side, pair and host admission limits, rate limiting, heartbeat cleanup, abrupt disconnects, and preserved close reasons.
- A stalled reader with queue exhaustion, a separate stalled reader reaching its write deadline, healthy-pair isolation, and SIGTERM drain with both voluntary completion and forced closure.

The [encrypted fixture](integration/tls_test.go) uses Go's [TLS implementation](https://pkg.go.dev/crypto/tls) at TLS 1.3 over a WebSocket-backed byte stream. The client trusts and pins a generated host certificate. Tests verify encrypted request/response, wrong host identity rejection, modified ciphertext rejection, replayed encrypted record rejection, and a fresh host reconnect. Test keys remain in endpoint memory. The relay contains no TLS record interpretation or application handshake logic.

Configuration validation, accounting for a write in progress, and admission-table capacity/expiry also have focused unit checks. The 4096-IP table bound is unit-tested rather than populated through 4096 network source addresses. Elixir checks do not apply to this Go-only implementation. Reverse-proxy deployment, WAN behavior, exhaustive WebSocket conformance, and long-running memory stability have not been tested.

## Benchmark method

`bench.sh` starts only local subprocesses and ephemeral ports. It prints JSON lines and writes each result plus raw latency arrays outside the worktree. The default destination is a new temporary directory printed in metadata. Select a persistent external directory with `-output /absolute/path`; configurable `-duration` and `-warmup` default to 1 s and 250 ms.

Acquire the shared-machine advisory lock with the command above. The lock helper must already exist at `/tmp/passio-relay-benchmark-lock.py`. The driver runs all combinations of 64 B, 1 KiB, and 64 KiB with 1, 32, and 128 paired clients. Both direct echo and relay modes repeat the 1 KiB/32-client case three times. Each client has one message in flight, and warmup samples are excluded from measurement.

RTT spans one binary request/echo exchange. Throughput counts successful exchanges per second; payload MiB/s counts both request and response bytes once. Establishment spans client dialing through the first verified echo, including host acceptance for relay mode. Host authentication happens separately. Connections are established sequentially, so establishment figures do not measure an admission burst.

CPU is the target process's cumulative CPU-time delta divided by measured duration; 100% means one core. RSS is sampled through `ps` every 100 ms. The driver and host endpoints share the machine but are excluded from relay CPU/RSS. The direct echo server is a separate subprocess using the same WebSocket library and client workload. Scheduling and resource-sampling overhead affect these short runs. Each mode reuses one target process across its matrix, so RSS also reflects preceding workloads.

The memory case measures 0, 100, and 500 idle pairs, using up to four hosts. It raises the global pair limit to 768, pending-per-host to 128, and admission rate to 100000. The per-host pair limit stays 128. Cleanup waits for socket/control events and checks zero live relay state. The churn workload reconnects the same host identity five times with 40 pairs per cycle. Idle snapshots span 500 ms; allocator RSS may remain high after state is released.

The slow-reader case measures an independent 1 KiB healthy pair before and during a stalled-reader flood. It records how many healthy exchanges overlap the stall. Its queue is 256 KiB/eight messages and its write deadline is 250 ms. This measures prompt disconnection and isolation, rather than sustained service to a slow consumer.

Measurements are provisional on a shared machine. They establish no production capacity, WAN latency, saturation limit, or long-term memory bound. The relay is single-node and provides neither transparent socket migration nor application exactly-once delivery. Full application integration, a production pairing/encryption SDK, multi-node routing, and cloud deployment remain outside this implementation.

## Measured results

The final locked run on 2026-10-03 used Darwin 27.0.0 arm64, an Apple M5 Max with 18 logical CPUs, and 128 GiB physical memory. Go 1.27.1 ran with `GOMAXPROCS=18`; Gorilla WebSocket was v1.5.3. Build flags and binary SHA-256 hashes are recorded in the metadata.

Raw artifacts: `/tmp/passio-relay-go-r01-final.qufS18/`. `results.jsonl` contains every summary, `metadata.json` records the environment, and each `*-samples.json` preserves individual RTT and establishment samples. The earlier complete run remains at `/tmp/passio-relay-go-r01.gr44Gj/`. The tables below use only the final run.

Each matrix cell measured approximately one second after 250 ms of warmup. Rates count echo exchanges. RTT triples are p50/p95/p99 in milliseconds; MiB/s counts request plus response payload. The main-case row uses repetition one.

| Payload | Clients | Relay RTT ms | Direct RTT ms | Relay exchanges/s | Direct exchanges/s | Relay MiB/s | Direct MiB/s | Relay CPU % | Relay peak RSS MiB |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 64 B | 1 | 0.050/0.066/0.102 | 0.019/0.027/0.035 | 18,719 | 49,561 | 2.3 | 6.0 | 82.0 | 18.1 |
| 64 B | 32 | 0.657/0.854/0.986 | 0.318/0.441/0.547 | 47,744 | 98,028 | 5.8 | 12.0 | 439.8 | 25.2 |
| 64 B | 128 | 2.767/3.200/3.568 | 1.292/1.494/1.811 | 45,717 | 98,137 | 5.6 | 12.0 | 472.1 | 40.2 |
| 1 KiB | 1 | 0.053/0.071/0.103 | 0.021/0.046/0.091 | 17,964 | 38,366 | 35.1 | 74.9 | 87.0 | 41.9 |
| 1 KiB | 32 | 0.685/0.932/1.143 | 0.343/0.549/0.820 | 45,453 | 88,074 | 88.8 | 172.0 | 462.8 | 42.0 |
| 1 KiB | 128 | 2.837/3.340/3.954 | 1.325/1.695/2.205 | 44,656 | 94,644 | 87.2 | 184.9 | 474.2 | 44.0 |
| 64 KiB | 1 | 0.181/0.337/0.428 | 0.082/0.159/0.209 | 4,733 | 10,492 | 591.6 | 1311.5 | 122.0 | 44.1 |
| 64 KiB | 32 | 4.098/5.743/6.936 | 2.002/3.344/4.228 | 7,551 | 15,266 | 943.9 | 1908.2 | 440.3 | 44.2 |
| 64 KiB | 128 | 17.434/19.352/21.097 | 7.766/9.289/11.429 | 7,270 | 16,163 | 908.7 | 2020.4 | 390.3 | 49.6 |

The repeated 1 KiB/32-client relay case measured:

| Repetition | Successful samples | Duration s | RTT p50/p95/p99 ms | Establishment p50/p95/p99 ms | Exchanges/s |
| --- | ---: | ---: | --- | --- | ---: |
| 1 | 45,476 | 1.000505 | 0.685/0.932/1.143 | 0.260/0.378/0.479 | 45,453 |
| 2 | 43,676 | 1.000469 | 0.708/0.989/1.266 | 0.266/0.496/0.497 | 43,656 |
| 3 | 39,300 | 1.000411 | 0.785/1.094/1.374 | 0.256/0.297/0.300 | 39,284 |

All 22 matrix runs completed with zero failures, timeouts, or corruption. Direct main-case throughput ranged from 88,074 to 94,334 exchanges/s. Its establishment p95 ranged from 0.146 to 0.216 ms. Raw files retain the corresponding sample counts, durations, CPU/RSS, and every workload’s establishment percentiles.

| Idle pairs | Hosts | Peak RSS MiB | Cleanup seconds | RSS after cleanup MiB |
| --- | ---: | ---: | ---: | ---: |
| 0 | 0 | 11.17 | 0.000000 | 11.50 |
| 100 | 1 | 23.16 | 0.009628 | 23.95 |
| 500 | 4 | 60.95 | 0.034534 | 61.91 |

Every cleanup left zero active hosts, active pairs, and pending pairs. RSS did not return to the cold-process baseline during the 500 ms observation window. The 200-pair reconnect churn completed in 0.076 s with no failed or corrupted echoes; establishment p95 was 0.513 ms. RSS after churn was 69.66 MiB. This short workload does not establish long-term leak freedom.

During slow-reader isolation, the healthy pair’s p50/p95/p99 changed from 0.056/0.097/0.167 ms to 0.062/0.103/0.154 ms, with zero failures. Five healthy exchanges overlapped the stall before its pair was released after 1.49 ms. The rapid queue-limit disconnection limits the duration of this isolation evidence.
