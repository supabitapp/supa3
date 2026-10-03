import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Host, connect, connectStatus, getJson, keyPair, metricsWhere, sign, startRelay } from "../lib.js";

describe("host registration", () => {
  let relay;
  before(async () => {
    relay = await startRelay({ RELAY_AUTH_TIMEOUT_MS: "400" });
  });
  after(() => relay.stop());

  test("healthz and metrics expose only counters", async () => {
    assert.deepEqual(await getJson(`${relay.http}/healthz`), { status: 200, body: { status: "ok" } });
    const { status, body } = await getJson(`${relay.http}/metrics`);
    assert.equal(status, 200);
    for (const key of ["activeHosts", "activePairs", "pendingPairs", "forwardedMessages", "forwardedBytes", "rejectedConnections"]) {
      assert.equal(typeof body[key], "number", key);
    }
  });

  test("valid signature registers and returns the endpoint id", async () => {
    const host = await Host.register(relay);
    assert.match(host.endpointId, /^[0-9a-f]{64}$/);
    await metricsWhere(relay, (m) => m.activeHosts >= 1, "host counted");
    await host.close();
  });

  test("invalid and missing signatures are rejected with 1008", async () => {
    const keys = keyPair();
    const other = keyPair();
    const replies = [
      (nonce) => ({ type: "authenticate", signature: sign(other, keys.endpointId, nonce) }),
      () => ({ type: "authenticate" }),
      () => ({ type: "authenticate", signature: "%%%" }),
      (nonce) => ({ type: "authenticate", signature: `${sign(keys, keys.endpointId, nonce)}=` }),
      (nonce) => ({ type: "hello", signature: sign(keys, keys.endpointId, nonce) }),
    ];
    for (const reply of replies) {
      const { control, challenge } = await Host.open(relay, keys);
      await control.send(JSON.stringify(reply(challenge.nonce)));
      assert.equal((await control.waitClose()).code, 1008);
    }
  });

  test("signature over the wrong endpoint or nonce is rejected", async () => {
    const keys = keyPair();
    const { control, challenge } = await Host.open(relay, keys);
    await control.send(JSON.stringify({ type: "authenticate", signature: sign(keys, "0".repeat(64), challenge.nonce) }));
    assert.equal((await control.waitClose()).code, 1008);
  });

  test("noncanonical and malformed public keys are rejected before upgrade", async () => {
    const keys = keyPair();
    const raw = Buffer.from(keys.publicKeyB64, "base64url");
    const last = keys.publicKeyB64.at(-1);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const noncanonical = keys.publicKeyB64.slice(0, -1) + alphabet[(alphabet.indexOf(last) & ~3) | ((alphabet.indexOf(last) + 1) & 3)];
    assert.deepEqual(Buffer.from(noncanonical, "base64url"), raw);
    for (const bad of [
      `${keys.publicKeyB64}=`,
      noncanonical,
      raw.toString("base64"),
      Buffer.alloc(31).toString("base64url"),
      Buffer.alloc(33).toString("base64url"),
      "",
    ]) {
      assert.equal(await connectStatus(`${relay.ws}/v1/control?publicKey=${encodeURIComponent(bad)}`), 400, bad);
    }
    assert.equal(await connectStatus(`${relay.ws}/v1/control`), 400);
  });

  test("a replayed challenge signature fails on a new socket", async () => {
    const keys = keyPair();
    const first = await Host.open(relay, keys);
    const signature = sign(keys, keys.endpointId, first.challenge.nonce);
    await first.control.send(JSON.stringify({ type: "authenticate", signature }));
    assert.equal((await first.control.json()).type, "registered");
    await first.control.close(1000);
    const second = await Host.open(relay, keys);
    assert.notEqual(second.challenge.nonce, first.challenge.nonce);
    await second.control.send(JSON.stringify({ type: "authenticate", signature }));
    assert.equal((await second.control.waitClose()).code, 1008);
  });

  test("a nonce is single use within its socket", async () => {
    const keys = keyPair();
    const { control, challenge } = await Host.open(relay, keys);
    const signature = sign(keys, keys.endpointId, challenge.nonce);
    await control.send(JSON.stringify({ type: "authenticate", signature }));
    assert.equal((await control.json()).type, "registered");
    await control.send(JSON.stringify({ type: "authenticate", signature }));
    assert.equal((await control.waitClose()).code, 1008);
  });

  test("an unanswered challenge expires after the auth timeout", async () => {
    const { control } = await Host.open(relay);
    const closed = await control.waitClose(2000);
    assert.equal(closed.code, 1008);
    assert.equal(closed.reason, "authentication timeout");
  });

  test("a stolen endpoint claim is rejected and the existing host keeps working", async () => {
    const keys = keyPair();
    const host = await Host.register(relay, keys);
    const thief = await Host.open(relay, keys);
    await thief.control.send(JSON.stringify({ type: "authenticate", signature: sign(keys, keys.endpointId, thief.challenge.nonce) }));
    const closed = await thief.control.waitClose();
    assert.equal(closed.code, 1008);
    assert.equal(closed.reason, "endpoint already registered");
    const impostor = keyPair();
    const forged = await connect(`${relay.ws}/v1/control?publicKey=${keys.publicKeyB64}`);
    const challenge = await forged.json();
    await forged.send(JSON.stringify({ type: "authenticate", signature: sign(impostor, keys.endpointId, challenge.nonce) }));
    assert.equal((await forged.waitClose()).code, 1008);
    const { client, data } = await host.pair();
    await client.send("still mine");
    assert.equal((await data.next()).data.toString(), "still mine");
    await client.close(1000);
    await host.close();
  });

  test("the legitimate host can register again after its control socket closes", async () => {
    const keys = keyPair();
    const host = await Host.register(relay, keys);
    await host.close();
    await metricsWhere(relay, (m) => m.activeHosts === 0, "old registration released");
    const again = await Host.register(relay, keys);
    const { client, data } = await again.pair();
    await data.send("back");
    assert.equal((await client.next()).data.toString(), "back");
    await again.close();
  });
});
