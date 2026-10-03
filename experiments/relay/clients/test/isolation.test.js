import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Host, connect, connectStatus, metricsWhere, startRelay } from "../lib.js";

describe("multi-host isolation and data tokens", () => {
  let relay;
  before(async () => {
    relay = await startRelay();
  });
  after(() => relay.stop());

  test("simultaneous clients on several hosts never receive each other's traffic", async () => {
    const hosts = await Promise.all([0, 1, 2].map(() => Host.register(relay)));
    const pairs = [];
    await Promise.all(
      hosts.map(async (host, h) => {
        const clients = await Promise.all(
          [0, 1, 2, 3, 4].map(() => connect(`${relay.ws}/v1/connect?endpointId=${host.endpointId}`)),
        );
        for (let i = 0; i < clients.length; i++) {
          const incoming = await host.incoming();
          const data = await host.accept(incoming);
          pairs.push({ h, data, incoming });
        }
        for (const [i, client] of clients.entries()) pairs.push({ h, client, i });
      }),
    );
    const dataSockets = pairs.filter((p) => p.data);
    const clients = pairs.filter((p) => p.client);
    for (const { data } of dataSockets) {
      data.ws.on("message", (msg, isBinary) => data.ws.send(Buffer.concat([Buffer.from("echo:"), Buffer.from(msg)]), { binary: isBinary }));
    }
    await Promise.all(
      clients.map(async ({ client, h, i }) => {
        for (let n = 0; n < 50; n++) {
          const tag = `host${h}-client${i}-${n}-${crypto.randomBytes(8).toString("hex")}`;
          await client.send(tag);
          assert.equal((await client.next()).data.toString(), `echo:${tag}`);
        }
      }),
    );
    await Promise.all(clients.map(({ client }) => client.close(1000)));
    await Promise.all(hosts.map((h) => h.close()));
  });

  test("wrong, missing, reused and cross-endpoint tokens are rejected before upgrade", async () => {
    const a = await Host.register(relay);
    const b = await Host.register(relay);
    const client = await connect(`${relay.ws}/v1/connect?endpointId=${a.endpointId}`);
    const incoming = await a.incoming();
    const wrong = crypto.randomBytes(32).toString("base64url");
    assert.equal(await connectStatus(a.acceptUrl(incoming, { token: wrong })), 403);
    assert.equal(await connectStatus(a.acceptUrl(incoming, { token: "" })), 403);
    assert.equal(await connectStatus(`${relay.ws}/v1/accept?endpointId=${a.endpointId}&connectionId=${incoming.connectionId}`), 403);
    assert.equal(await connectStatus(b.acceptUrl(incoming, { endpointId: b.endpointId })), 404);
    assert.equal(await connectStatus(a.acceptUrl(incoming, { connectionId: crypto.randomBytes(16).toString("base64url") })), 404);
    const data = await a.accept(incoming);
    assert.equal(await connectStatus(a.acceptUrl(incoming)), 403);
    await client.send("ok");
    assert.equal((await data.next()).data.toString(), "ok");
    await client.close(1000);
    await a.close();
    await b.close();
  });

  test("closing a host control socket closes its pending and active pairs and stales its tokens", async () => {
    const keys = (await import("../lib.js")).keyPair();
    const host = await Host.register(relay, keys);
    const active = await host.pair();
    const pendingClient = await connect(`${relay.ws}/v1/connect?endpointId=${host.endpointId}`);
    const pendingIncoming = await host.incoming();
    await metricsWhere(relay, (m) => m.pendingPairs === 1 && m.activePairs === 1, "one pending, one active");
    await host.close();
    assert.equal((await active.client.waitClose()).code, 1001);
    assert.equal((await active.data.waitClose()).code, 1001);
    assert.equal((await pendingClient.waitClose()).code, 1001);
    await metricsWhere(relay, (m) => m.activeHosts === 0 && m.pendingPairs === 0 && m.activePairs === 0, "host state released");
    const again = await Host.register(relay, keys);
    assert.equal(await connectStatus(again.acceptUrl(pendingIncoming)), 404);
    const fresh = await again.pair();
    await fresh.client.send("new generation");
    assert.equal((await fresh.data.next()).data.toString(), "new generation");
    await fresh.client.close(1000);
    await again.closedEvent(fresh.incoming.connectionId);
    assert.equal(again.events.filter((e) => e.connectionId === pendingIncoming.connectionId).length, 0);
    await again.close();
  });
});
