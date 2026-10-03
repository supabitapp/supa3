import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Host, connect, connectStatus, deadline, getJson, keyPair, startRelay } from "../lib.js";

describe("graceful SIGTERM drain", () => {
  test("drain stops admissions, lets an active pair finish, then exits", async () => {
    const relay = await startRelay();
    const host = await Host.register(relay);
    const active = await host.pair();
    const pendingClient = await connect(`${relay.ws}/v1/connect?endpointId=${host.endpointId}`);
    await host.incoming();
    process.kill(relay.pid, "SIGTERM");
    assert.equal((await pendingClient.waitClose()).code, 1001);
    assert.deepEqual(await getJson(`${relay.http}/healthz`), { status: 503, body: { status: "draining" } });
    assert.equal(await connectStatus(`${relay.ws}/v1/connect?endpointId=${host.endpointId}`), 503);
    assert.equal(await connectStatus(`${relay.ws}/v1/control?publicKey=${keyPair().publicKeyB64}`), 503);
    await active.client.send("still flowing");
    assert.equal((await active.data.next()).data.toString(), "still flowing");
    await active.data.send("reply");
    assert.equal((await active.client.next()).data.toString(), "reply");
    const started = Date.now();
    await active.client.close(1000, "finished");
    assert.equal((await host.control.waitClose(3000)).code, 1001);
    const exit = await deadline(relay.exited, 3000, "relay exit");
    assert.equal(exit.code, 0);
    assert.ok(Date.now() - started < 2000);
  });

  test("pairs still open after the 5 second grace are closed with 1001", async () => {
    const relay = await startRelay();
    const host = await Host.register(relay);
    const active = await host.pair();
    const started = Date.now();
    process.kill(relay.pid, "SIGTERM");
    assert.equal((await active.client.waitClose(8000)).code, 1001);
    assert.equal((await active.data.waitClose(1000)).code, 1001);
    const exit = await deadline(relay.exited, 3000, "relay exit");
    const elapsed = Date.now() - started;
    assert.equal(exit.code, 0);
    assert.ok(elapsed >= 4900 && elapsed < 7000, `drain took ${elapsed}ms`);
  });
});
