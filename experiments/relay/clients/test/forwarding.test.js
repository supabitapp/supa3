import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Host, connectStatus, metricsWhere, startRelay } from "../lib.js";

const MAX = 65536;

describe("opaque forwarding", () => {
  let relay;
  let host;
  before(async () => {
    relay = await startRelay({ RELAY_MAX_MESSAGE_BYTES: String(MAX), RELAY_MAX_QUEUE_BYTES: String(MAX * 8) });
    host = await Host.register(relay);
  });
  after(() => relay.stop());

  async function roundTrip(from, to, data, options) {
    await from.send(data, options);
    return to.next();
  }

  test("text, binary and empty payloads cross unchanged in both directions", async () => {
    const { client, data } = await host.pair();
    const cases = [
      ["héllo ✓ wörld", { binary: false }],
      [crypto.randomBytes(4096), { binary: true }],
      [Buffer.from([0, 255, 0, 1, 2]), { binary: true }],
      ["", { binary: false }],
      [Buffer.alloc(0), { binary: true }],
    ];
    for (const [from, to] of [[client, data], [data, client]]) {
      for (const [payload, options] of cases) {
        const got = await roundTrip(from, to, payload, options);
        assert.equal(got.isBinary, options.binary);
        assert.deepEqual(got.data, Buffer.from(payload));
      }
    }
    await client.close(1000);
  });

  test("the client data socket receives no relay control records", async () => {
    const { client, data } = await host.pair();
    await data.send("first");
    const got = await client.next();
    assert.equal(got.data.toString(), "first");
    await client.close(1000);
  });

  test("payloads that look like relay or handshake JSON are forwarded unchanged", async () => {
    const { client, data, incoming } = await host.pair();
    const payloads = [
      JSON.stringify({ type: "hello", version: 1 }),
      JSON.stringify({ type: "e2ee_hello", publicKey: crypto.randomBytes(32).toString("base64url") }),
      JSON.stringify({ type: "challenge", nonce: "abc" }),
      JSON.stringify({ type: "authenticate", signature: "abc" }),
      JSON.stringify({ type: "incoming", connectionId: incoming.connectionId, token: "x" }),
      JSON.stringify({ type: "closed", connectionId: incoming.connectionId }),
      JSON.stringify({ type: "registered", endpointId: host.endpointId }),
      "{not json",
    ];
    for (const payload of payloads) {
      assert.equal((await roundTrip(client, data, payload)).data.toString(), payload);
      assert.equal((await roundTrip(data, client, payload)).data.toString(), payload);
    }
    assert.equal(host.events.filter((e) => e.type === "incoming").length, 0);
    await client.close(1000);
  });

  test("messages exactly at the size limit pass and keep boundaries and order", async () => {
    const { client, data } = await host.pair();
    const exact = crypto.randomBytes(MAX);
    assert.deepEqual((await roundTrip(client, data, exact)).data, exact);
    assert.deepEqual((await roundTrip(data, client, exact)).data, exact);
    const sent = [];
    for (let i = 0; i < 500; i++) {
      const payload = i % 2 ? Buffer.concat([Buffer.from(String(i)), crypto.randomBytes(i)]) : `text-${i}`;
      sent.push(payload);
      client.send(payload);
    }
    for (let i = 0; i < 500; i++) {
      const got = await data.next();
      assert.equal(got.isBinary, i % 2 === 1);
      assert.deepEqual(got.data, Buffer.from(sent[i]));
    }
    await client.close(1000);
  });

  test("an oversize message closes the pair with 1009", async () => {
    const { client, data } = await host.pair();
    client.send(crypto.randomBytes(MAX + 1));
    assert.equal((await client.waitClose()).code, 1009);
    assert.equal((await data.waitClose()).code, 1009);
  });

  test("close codes and reasons propagate; abnormal closes map to 1011", async () => {
    let pair = await host.pair();
    pair.client.close(4001, "client says bye");
    assert.deepEqual(await pair.data.waitClose(), { code: 4001, reason: "client says bye" });
    assert.equal((await host.closedEvent(pair.incoming.connectionId)).type, "closed");

    pair = await host.pair();
    pair.data.close(3001, "host says bye");
    assert.deepEqual(await pair.client.waitClose(), { code: 3001, reason: "host says bye" });

    pair = await host.pair();
    pair.client.ws.close();
    assert.equal((await pair.data.waitClose()).code, 1000);

    pair = await host.pair();
    pair.client.ws._socket.destroy();
    assert.deepEqual(await pair.data.waitClose(), { code: 1011, reason: "peer connection lost" });
    await host.closedEvent(pair.incoming.connectionId);

    pair = await host.pair();
    pair.data.ws._socket.destroy();
    assert.equal((await pair.client.waitClose()).code, 1011);
    await host.closedEvent(pair.incoming.connectionId);
    await metricsWhere(relay, (m) => m.activePairs === 0 && m.pendingPairs === 0, "pairs released");
    for (const count of host.closedCounts.values()) assert.equal(count, 1);
  });

  test("an unknown endpoint is rejected with 404 before upgrade", async () => {
    assert.equal(await connectStatus(`${relay.ws}/v1/connect?endpointId=${"ab".repeat(32)}`), 404);
    assert.equal(await connectStatus(`${relay.ws}/v1/connect?endpointId=nothex`), 400);
  });
});
