import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Host, connect, connectStatus, deadline, getJson, metricsWhere, startRelay, waitFor } from "../lib.js";

const KIB16 = 16 * 1024;

function flood(conn, size, until, { paced = false } = {}) {
  const payload = crypto.randomBytes(size);
  let stopped = false;
  until.finally(() => {
    stopped = true;
  });
  const pump = () => {
    if (paced) conn.ws.send(payload);
    else for (let n = 0; n < 32 && !stopped && conn.ws.readyState === 1 && conn.ws.bufferedAmount < 1024 * 1024; n++) conn.ws.send(payload);
    if (!stopped && conn.ws.readyState === 1) (paced ? setTimeout : setImmediate)(pump, 1);
  };
  pump();
}

async function echoRounds(pair, rounds) {
  pair.data.ws.on("message", (msg, isBinary) => pair.data.ws.send(msg, { binary: isBinary }));
  for (let i = 0; i < rounds; i++) {
    await pair.client.send(`healthy-${i}`);
    assert.equal((await pair.client.next(2000)).data.toString(), `healthy-${i}`);
  }
}

describe("pending pairs and queue limits", () => {
  let relay;
  let host;
  before(async () => {
    relay = await startRelay({
      RELAY_MAX_MESSAGE_BYTES: String(KIB16),
      RELAY_MAX_QUEUE_BYTES: String(KIB16 * 4),
      RELAY_MAX_QUEUE_MESSAGES: "8",
      RELAY_PAIR_TIMEOUT_MS: "300",
    });
    host = await Host.register(relay);
  });
  after(() => relay.stop());

  test("client messages sent before pairing are buffered and drained in order", async () => {
    const client = await connect(`${relay.ws}/v1/connect?endpointId=${host.endpointId}`);
    const incoming = await host.incoming();
    for (let i = 0; i < 6; i++) await client.send(i % 2 ? Buffer.from([i]) : `early-${i}`);
    const data = await host.accept(incoming);
    for (let i = 0; i < 6; i++) {
      const got = await data.next();
      assert.deepEqual(got.data, Buffer.from(i % 2 ? Buffer.from([i]) : `early-${i}`));
    }
    await client.send("late");
    assert.equal((await data.next()).data.toString(), "late");
    await client.close(1000);
  });

  test("exceeding the pending message limit closes the client with 1013", async () => {
    const client = await connect(`${relay.ws}/v1/connect?endpointId=${host.endpointId}`);
    const incoming = await host.incoming();
    for (let i = 0; i < 9; i++) client.send(`m${i}`);
    assert.equal((await client.waitClose()).code, 1013);
    await host.closedEvent(incoming.connectionId);
    assert.equal(await connectStatus(host.acceptUrl(incoming)), 404);
  });

  test("exceeding the pending byte limit closes the client with 1013", async () => {
    const client = await connect(`${relay.ws}/v1/connect?endpointId=${host.endpointId}`);
    const incoming = await host.incoming();
    for (let i = 0; i < 5; i++) client.send(crypto.randomBytes(KIB16));
    assert.equal((await client.waitClose()).code, 1013);
    await host.closedEvent(incoming.connectionId);
  });

  test("an unaccepted pair times out and releases all state", async () => {
    const client = await connect(`${relay.ws}/v1/connect?endpointId=${host.endpointId}`);
    const incoming = await host.incoming();
    const closed = await client.waitClose(2000);
    assert.deepEqual(closed, { code: 1013, reason: "pair timeout" });
    await host.closedEvent(incoming.connectionId);
    assert.equal(await connectStatus(host.acceptUrl(incoming)), 404);
    await metricsWhere(relay, (m) => m.pendingPairs === 0 && m.activePairs === 0, "pending released");
  });

  test("a stalled reader overflows only its own pair while another pair stays healthy", async () => {
    const stalled = await host.pair();
    const healthy = await host.pair();
    stalled.client.ws._socket.pause();
    const hostClosed = stalled.data.waitClose(10000, "stalled pair close");
    flood(stalled.data, KIB16, hostClosed);
    await echoRounds(healthy, 200);
    assert.equal((await hostClosed).code, 1013);
    await healthy.client.send("after");
    assert.equal((await healthy.client.next()).data.toString(), "after");
    stalled.client.ws.terminate();
    await healthy.client.close(1000);
    await metricsWhere(relay, (m) => m.activePairs === 0, "pairs released");
  });
});

describe("write deadline", () => {
  let relay;
  before(async () => {
    relay = await startRelay({
      RELAY_MAX_MESSAGE_BYTES: String(KIB16),
      RELAY_MAX_QUEUE_BYTES: String(64 * 1024 * 1024),
      RELAY_MAX_QUEUE_MESSAGES: "100000",
      RELAY_WRITE_TIMEOUT_MS: "300",
    });
  });
  after(() => relay.stop());

  test("a reader that stops draining its socket is closed by the write timeout", async () => {
    const host = await Host.register(relay);
    const stalled = await host.pair();
    const healthy = await host.pair();
    stalled.client.ws._socket.pause();
    const hostClosed = stalled.data.waitClose(15000, "write timeout close");
    flood(stalled.data, KIB16, hostClosed, { paced: true });
    await echoRounds(healthy, 50);
    assert.equal((await hostClosed).code, 1011);
    await host.closedEvent(stalled.incoming.connectionId);
    stalled.client.ws.terminate();
    await healthy.client.close(1000);
  });
});

describe("heartbeat", () => {
  let relay;
  before(async () => {
    relay = await startRelay({ RELAY_HEARTBEAT_MS: "200" });
  });
  after(() => relay.stop());

  test("answering clients stay connected across many heartbeats", async () => {
    const host = await Host.register(relay);
    const pair = await host.pair();
    let pings = 0;
    const fivePings = new Promise((resolve) => pair.client.ws.on("ping", () => ++pings === 5 && resolve()));
    await deadline(fivePings, 3000, "five relay pings");
    await pair.client.send("alive");
    assert.equal((await pair.data.next()).data.toString(), "alive");
    await pair.client.close(1000);
    await host.close();
  });

  test("a silent data peer is closed and its pair released", async () => {
    const host = await Host.register(relay);
    const pair = await host.pair();
    pair.client.ws._socket.pause();
    assert.deepEqual(await pair.data.waitClose(3000), { code: 1011, reason: "heartbeat timeout" });
    await host.closedEvent(pair.incoming.connectionId);
    pair.client.ws.terminate();
    await host.close();
  });

  test("a silent host control socket is unregistered and its pairs are closed", async () => {
    const host = await Host.register(relay);
    const pair = await host.pair();
    host.control.ws._socket.pause();
    assert.equal((await pair.client.waitClose(3000)).code, 1001);
    await metricsWhere(relay, (m) => m.activeHosts === 0 && m.activePairs === 0, "host released");
    host.control.ws.terminate();
  });
});

describe("connection and admission limits", () => {
  let relay;
  before(async () => {
    relay = await startRelay({
      RELAY_MAX_CLIENTS: "4",
      RELAY_MAX_CLIENTS_PER_HOST: "3",
      RELAY_MAX_PENDING_PER_HOST: "2",
      RELAY_ADMISSION_RATE: "20",
    });
  });
  after(() => relay.stop());

  test("pending, per-host and global limits reject with 503", async () => {
    const a = await Host.register(relay);
    const b = await Host.register(relay);
    const url = (h) => `${relay.ws}/v1/connect?endpointId=${h.endpointId}`;
    const c1 = await connect(url(a));
    const c2 = await connect(url(a));
    assert.equal(await connectStatus(url(a)), 503);
    const i1 = await a.incoming();
    await a.incoming();
    const d1 = await a.accept(i1);
    const c3 = await connect(url(a));
    assert.equal(await connectStatus(url(a)), 503);
    const c4 = await connect(url(b));
    assert.equal(await connectStatus(url(b)), 503);
    await metricsWhere(relay, (m) => m.activePairs === 1 && m.pendingPairs === 3, "limit state");
    for (const c of [c1, c2, c3, c4]) await c.close(1000);
    await d1.waitClose();
    await metricsWhere(relay, (m) => m.activePairs === 0 && m.pendingPairs === 0, "released");
    assert.equal(await connectStatus(url(b)), 101);
    await a.close();
    await b.close();
  });

  test("per-IP admission rate limiting returns 429 and counts rejections", async () => {
    const before = (await getJson(`${relay.http}/metrics`)).body.rejectedConnections;
    const statuses = [];
    for (let i = 0; i < 80; i++) statuses.push(await connectStatus(`${relay.ws}/v1/connect?endpointId=${"cd".repeat(32)}`));
    assert.ok(statuses.includes(429), `expected 429 in ${statuses}`);
    assert.ok(statuses.filter((s) => s === 404).length <= 40 + 4, "burst bounded by 2x rate");
    assert.equal((await getJson(`${relay.http}/healthz`)).status, 200);
    const after = (await getJson(`${relay.http}/metrics`)).body.rejectedConnections;
    assert.equal(after - before, statuses.length);
  });
});

async function churnOnce(url) {
  try {
    const conn = await connect(url);
    conn.ws._socket.resetAndDestroy();
    return 101;
  } catch (err) {
    return err.status ?? err.message;
  }
}

describe("control notification queue", () => {
  let relay;
  before(async () => {
    relay = await startRelay({
      RELAY_MAX_MESSAGE_BYTES: "16384",
      RELAY_MAX_QUEUE_BYTES: "16384",
      RELAY_ADMISSION_RATE: "1000000",
    });
  });
  after(() => relay.stop());

  test("a reading control socket keeps its registration through bounded churn with a 16 KiB budget", async () => {
    const host = await Host.register(relay);
    const url = `${relay.ws}/v1/connect?endpointId=${host.endpointId}`;
    let admitted = 0;
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        for (let i = 0; i < 30; i++) {
          const status = await churnOnce(url);
          assert.ok(status === 101 || status === 503, `unexpected ${status}`);
          if (status === 101) admitted++;
        }
      }),
    );
    await waitFor(() => host.closedCounts.size === admitted, "all closed notifications delivered", 10000);
    for (const count of host.closedCounts.values()) assert.equal(count, 1);
    assert.equal(host.events.filter((e) => e.type === "incoming").length, admitted);
    host.events.length = 0;
    const pair = await host.pair();
    await pair.client.send("still registered");
    assert.equal((await pair.data.next()).data.toString(), "still registered");
    await pair.client.close(1000);
    await host.close();
  });
});
