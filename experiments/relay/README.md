# Passio relay

This directory contains a standalone, single-node Elixir WebSocket relay and runnable endpoint fixtures. The relay forwards opaque messages. Endpoints own application authorization and encryption.

## Build and verify

Run these commands from the repository root. They were verified on macOS with Homebrew Elixir/Erlang, Node, npm, Python 3, and `/usr/bin/openssl`.

```bash
bash experiments/relay/build.sh
RELAY_ADDR=127.0.0.1:0 bash experiments/relay/run.sh
bash experiments/relay/test.sh
python3 /tmp/passio-relay-benchmark-lock.py -- bash experiments/relay/bench.sh
```

`build.sh` uses `/opt/homebrew/bin/mix`, local `.mix` and `.hex` caches, and an optimized `MIX_ENV=prod` release with stripped BEAM files. Dependencies and outputs stay in this directory and are ignored. `run.sh` executes that release without rebuilding. Both scripts default to `ERL_FLAGS='+S 4:4'`; an explicit `ERL_FLAGS` overrides the scheduler setting. Distribution is disabled.

Startup prints one JSON line to stdout, such as `{"event":"listening","address":"127.0.0.1:54321"}`. Port zero selects an ephemeral port. Other logging goes to stderr. Runtime error reports are redacted to avoid printing handler state, query credentials, or payloads.

`test.sh` checks formatting, compilation warnings, ExUnit, JavaScript syntax, and real socket integration against the built release. Rebuild after editing Elixir sources. It installs the isolated fixture dependency with `npm ci`. Tests spawn only ephemeral loopback listeners and stop their own processes.

## Wire protocol

Use HTTP/1.1 WebSocket upgrades. Compression is disabled. All Base64URL values are canonical and unpadded. Query parameters cannot repeat.

1. Open `/v1/control?publicKey=KEY`, where `KEY` encodes the raw 32-byte Ed25519 public key. The endpoint ID is the lowercase hexadecimal SHA-256 digest of those raw bytes.
2. Read `{"type":"challenge","nonce":"NONCE"}`. The nonce encodes 32 random bytes and belongs to this connection.
3. Sign the UTF-8 bytes `passio-relay-v1\nENDPOINT_ID\nNONCE`, using the nonce string exactly as received and no trailing newline. Send `{"type":"authenticate","signature":"SIGNATURE"}`, encoding the 64-byte Ed25519 signature with Base64URL.
4. Read `{"type":"registered","endpointId":"ENDPOINT_ID"}`. An invalid, expired, or replayed proof closes with 1008. A duplicate authenticated registration also closes with 1008 and leaves the original host registered.
5. A client opens `/v1/connect?endpointId=ENDPOINT_ID`. An unknown host returns HTTP 404 before upgrade. The host receives `{"type":"incoming","connectionId":"ID","token":"TOKEN"}` on its control socket. The random ID contains 16 bytes; the token contains 32 bytes.
6. The host opens `/v1/accept?endpointId=ENDPOINT_ID&connectionId=ID&token=TOKEN`. The token is consumed at admission and only authorizes this pending pair in this registration generation. Missing, wrong, expired, reused, or foreign tokens return HTTP 403 before upgrade.
7. Exchange text or binary messages on the client and accepted host sockets. Both directions preserve complete message boundaries, type, contents, and order. Empty messages are valid. Messages named `hello` or `e2ee_hello` have no relay meaning. Clients receive no relay JSON records.
8. Closing either data socket releases the pair and closes its peer. Legal peer close codes and reasons propagate where possible; abnormal transport loss maps to 1011. A live host control socket receives `{"type":"closed","connectionId":"ID"}` at most once. Closing control releases every pair belonging to that registration.

The relay buffers client messages while waiting for acceptance. Queue overflow closes with 1013, oversize messages with 1009, and pairing timeout with 1008. Once a host registration has been cleaned up, the same identity may register again. Generation references and pair process identities prevent old cleanup callbacks from removing replacements.

`GET /healthz` returns HTTP 200 with `{"status":"ok"}` while accepting traffic. During drain it returns 503 with `{"status":"draining"}`. `GET /metrics` exposes numeric `activeHosts`, `activePairs`, `pendingPairs`, `forwardedMessages`, `forwardedBytes`, and `rejectedConnections`, plus admission-IP and control-connection counts. Forwarded counters count completed local socket writes in both directions, including zero-length messages. They do not acknowledge endpoint receipt. Metrics contain no message data or credentials.

## Configuration

All numeric settings require integers from 1 through 1073741824. Bad settings fail startup. Address ports range from 0 through 65535. The effective limit is the smallest applicable global, host, or pending limit.

| Variable | Default | Usage |
| --- | ---: | --- |
| `RELAY_ADDR` | `127.0.0.1:8080` | Bind a numeric IPv4 address or `[IPv6]:port`; port 0 prints the actual address. |
| `RELAY_MAX_MESSAGE_BYTES` | 1048576 | Maximum complete data message, including fragmented messages; control messages have a fixed 4 KiB limit. |
| `RELAY_MAX_QUEUE_BYTES` | 4194304 | Queued application bytes per data direction, including the write in progress. |
| `RELAY_MAX_QUEUE_MESSAGES` | 256 | Queued messages per direction, including empty messages and the write in progress. |
| `RELAY_MAX_CLIENTS` | 1024 | Global pending plus admitted pairs; also caps control sockets including unauthenticated reservations. |
| `RELAY_MAX_CLIENTS_PER_HOST` | 128 | Pending plus admitted pairs for one host generation. |
| `RELAY_MAX_PENDING_PER_HOST` | 32 | Clients awaiting host acceptance. |
| `RELAY_AUTH_TIMEOUT_MS` | 5000 | Authentication lifetime from control admission; also bounds initial HTTP request time. |
| `RELAY_PAIR_TIMEOUT_MS` | 5000 | Time allowed for both data sockets to attach. |
| `RELAY_WRITE_TIMEOUT_MS` | 5000 | Transport write deadline and outbox acknowledgement deadline. |
| `RELAY_HEARTBEAT_MS` | 15000 | Relay ping interval; a matching pong must arrive before the next interval. |
| `RELAY_ADMISSION_RATE` | 100 | Token refill per second per TCP peer IP; burst capacity equals this value. |

The rate limiter tracks at most 4096 IP addresses. Entries expire after 60 seconds without an attempt, with a one-second sweep. When full, it rejects new IPs until space becomes available. It ignores forwarded-IP headers. Pair/admission limits return 429; a full control reservation pool returns 503. Initial HTTP connection counts are bounded separately through Ranch.

Each control outbox has fixed bounds of 256 messages and 256 KiB, independent of data limits. Each pair has its own process and two outboxes. Each outbox sends at most one message to its socket at a time and retains accounting until the transport send returns. Inbound reads use `active_n: 1`. TCP receive/send buffers and the driver high-water mark are configured to 16 KiB; the operating system may round socket buffers. Transport buffers and one bounded inbound message are additional to application queue limits. A write acknowledgement means local transport acceptance, not remote consumption.

A peer that omits the matching pong closes with 1001 after at most two heartbeat intervals from attachment. SIGTERM stops all new admissions immediately, permits existing pairs to finish for up to 4.75 seconds, then closes remaining sockets and exits within the five-second drain budget under the tested workload. Finishing the last pair ends drain early.

## Public deployment and trust

Public deployments require WSS through a TLS-terminating reverse proxy. Keep the relay listener on loopback or a private network, forward HTTP/1.1 Upgrade/Connection headers, and allow long-lived upgraded connections. Protect the metrics route through the proxy if operational counts should be private. Redact query strings from proxy access logs: accept URLs carry short-lived bearer tokens. No production keys or tokens are included here.

Behind a proxy, the relay rate-limits the proxy's TCP IP. Apply per-client IP limits at the trusted proxy and size the relay allowance for the aggregate. Forwarded headers cannot override relay rate limiting. TLS termination, reverse-proxy routing, and public-network deployment were not tested.

Host registration proves possession of the host key. Any client knowing an endpoint ID can request a connection and consume bounded admission capacity. Endpoints must authorize users and establish their own encryption. The relay has no application contracts, pairing logic, or encryption handshake parser. It provides neither transparent socket migration nor application exactly-once delivery. There is no durable state, multi-node routing, production endpoint SDK, or application integration.

The locked server dependencies are Cowboy 2.19.0, Cowlib 2.20.0, Ranch 2.3.0, and Jason 1.4.5. Hex reports [CVE-2026-43966](https://cna.erlef.org/cves/CVE-2026-43966.html) and [CVE-2026-43969](https://cna.erlef.org/cves/CVE-2026-43969.html) for Cowlib. These concern structured-header and client-cookie encoders. The relay uses static response headers, no structured-header encoding, and no cookie generation. These paths are not used by the implementation; the dependency advisories remain recorded. The fixture uses `ws` 8.22.0, with zero findings from `npm audit --omit=dev` on 2026-10-03.

## Correctness evidence

[The integration suite](clients/relay.test.mjs) tests live relay processes and actual host/client WebSockets. It covers registration, invalid/missing signatures, stolen claims, duplicate registration, challenge replay, reconnect, foreign/reused/stale tokens, and independent concurrent pairs. It also covers text, all byte values, empty messages, fragmented messages, ordered boundaries, handshake-like JSON, and unrelated XML payloads.

The same suite verifies pending buffer order and expiry, byte/message limits, oversized complete and fragmented messages, global/host/pending/control limits, IP rate limiting, heartbeat cleanup, abrupt transport loss, write timeouts, and slow-reader isolation. SIGTERM tests verify 503 admissions while an existing pair still works, forced closure within the drain budget, and early exit after the final pair finishes.

[The encrypted endpoint fixture](clients/encrypted.test.mjs) uses Node's TLS 1.3 implementation over WebSocket-backed byte streams. An ephemeral certificate and private key are generated outside the worktree and deleted afterwards. The client validates the certificate and pins its SHA-256 identity. Tests verify encrypted request/response, wrong-pin rejection, modified ciphertext rejection, encrypted-record replay rejection, and a fresh reconnect. Ciphertext modification and replay happen only in the endpoint fixture. The relay receives opaque binary messages throughout.

The verified run passed 5 ExUnit checks and 16 integration tests. IPv6 parsing has unit coverage; IPv6 sockets were not tested. The 4096-IP bookkeeping cap and 60-second eviction are implemented but were not exhausted with distinct real source IPs. Kernel buffer sizes, packet-loss behavior, and prolonged hostile traffic remain unmeasured. Close frames may be lost when an underlying TCP connection resets or a peer never reads.

## Benchmarks

`bench.sh` executes the built release and a separate direct-WebSocket echo process with the same driver and payload workload. It prints JSON lines and writes a final `report.json`, per-case RTT samples, establishment samples, and resource samples under a new `/tmp/passio-relay-elixir-bench-*` directory. It performs no build or dependency installation. Always run it through the advisory-lock command above; do not delete the lock file.

The matrix uses 64 B, 1 KiB, and 64 KiB at 1, 32, and 128 paired clients. Each case has 500 ms of excluded warmup and 1500 ms of measurement, with one message in flight per client. The 1 KiB/32-client case runs three times for each transport. Every response is checked byte-for-byte. Payload throughput counts request plus response bytes and excludes WebSocket framing.

Establishment samples include the client upgrade, host notification, and host data upgrade; host registration is excluded. Admissions are sequential. CPU is the relay or baseline process's cumulative CPU delta from `ps`, with 100% representing one core; RSS is sampled every 200 ms. The driver and endpoint CPU are excluded. Idle measurements use the warmed relay at 0, 100, and 500 pairs, with one-second observation and cleanup windows. The 500-pair case uses four hosts. Churn creates and disconnects 192 pairs in three rounds. Slow-reader isolation uses a separate relay with a 256 KiB queue and 250 ms write deadline.

Benchmarks raise `RELAY_MAX_CLIENTS` to 1200, `RELAY_MAX_PENDING_PER_HOST` to 128, and `RELAY_ADMISSION_RATE` to 10000; the per-host limit stays 128. Main measurements use a 1000 ms write deadline. The report records platform, runtime/dependency versions, scheduler flags, sample counts, actual durations, source digest, failures, timeouts, and corruption counts. Shared-machine loopback results are provisional. Short runs and a single endpoint driver cannot establish production capacity; warmed allocator retention also prevents interpreting RSS differences as an exact per-pair cost.

### Measured snapshot

On 2026-10-03, all 22 measured cases completed with zero failures, timeouts, or corruption across 2,146,361 echo RTT samples. The machine was an Apple M5 Max with 18 logical CPUs, Darwin 27.0.0 arm64, Elixir 1.20.4/OTP 29, Node 24.21.0, and `ws` 8.22.0. The release used four schedulers (`+S 4:4`).

Raw evidence: `/tmp/passio-relay-elixir-bench-pX2OMk/report.json`. Its directory contains every per-case sample file, `benchmark.jsonl`, build/test logs, and the fixture dependency audit. These local artifacts are outside version control. The source digest in the report matches the delivered Elixir sources and Mix lockfile.

The 1 KiB/32-client repetitions measured the following. Each row excludes warmup and contains approximately 1.5 seconds of traffic. MiB/s includes both directions; CPU uses the one-core convention described above.

| Transport/run | Echo samples | RTT p50/p95/p99, ms | Echoes/s | Payload MiB/s | CPU % | Peak RSS MiB | Establishment p95, ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| relay 1 | 78,831 | 0.581/0.935/1.169 | 52,544 | 102.62 | 362.1 | 157.3 | 0.539 |
| relay 2 | 76,308 | 0.609/0.909/1.156 | 50,854 | 99.32 | 361.3 | 245.1 | 0.454 |
| relay 3 | 104,031 | 0.449/0.562/0.761 | 69,342 | 135.43 | 372.1 | 196.8 | 0.514 |
| direct 1 | 216,698 | 0.215/0.337/0.407 | 144,451 | 282.13 | 96.5 | 88.6 | 0.252 |
| direct 2 | 195,032 | 0.237/0.377/0.558 | 130,010 | 253.93 | 96.0 | 209.5 | 0.311 |
| direct 3 | 200,690 | 0.230/0.372/0.620 | 133,781 | 261.29 | 95.5 | 209.5 | 0.369 |

The complete 64 B/1 KiB/64 KiB matrix at 1/32/128 clients is in `report.json`; each case has its own raw sample file. Relay peak RSS across that matrix reached 272.8 MiB in the 64 KiB/128-client case.

| Idle pairs | Hosts | End-of-idle RSS MiB | RSS after cleanup, MiB | Pairs after cleanup |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 163.38 | 154.38 | 0 |
| 100 | 1 | 154.16 | 153.12 | 0 |
| 500 | 4 | 174.03 | 173.05 | 0 |

The bounded churn run connected and disconnected 192 pairs in 106.1 ms, with establishment p50/p95/p99 of 0.346/0.715/1.034 ms and zero pairs remaining. Its short duration makes the CPU estimate coarse. During slow-reader isolation, the slow pair closed with 1013 after 704 KiB was offered. The independent healthy pair completed 27,989 echoes over 2.000 seconds, with p50/p95/p99 of 0.064/0.111/0.209 ms and no errors. Its relay peak RSS was 163.1 MiB.
