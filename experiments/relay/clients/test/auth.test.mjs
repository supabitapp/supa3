import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useRelay, expectRejected } from './helpers.mjs';
import { generateHostKey, signChallenge, urls } from '../lib/protocol.mjs';
import { connectHost, openControl, connectClient } from '../lib/host.mjs';
import { openWs, send, trackClose } from '../lib/ws.mjs';

const ctx = useRelay(test, { RELAY_AUTH_TIMEOUT_MS: '400' });

test('host registers and endpointId matches sha256 of the raw key', async () => {
  const key = generateHostKey();
  const host = await connectHost(ctx.relay.address, key);
  assert.equal((await ctx.relay.metrics()).activeHosts, 1);
  await host.close(1000, 'done');
  await ctx.relay.waitMetrics((m) => m.activeHosts === 0);
});

test('invalid signature is rejected with 1008', async () => {
  const key = generateHostKey();
  const other = generateHostKey();
  const control = await openControl(ctx.relay.address, key);
  await send(control.ws, JSON.stringify({ type: 'authenticate', signature: signChallenge(other, control.nonce) }));
  const close = await control.closeInfo;
  assert.equal(close.code, 1008);
  assert.equal((await ctx.relay.metrics()).activeHosts, 0);
});

test('garbage, missing signature and non-text frames are rejected with 1008', async () => {
  for (const payload of ['not json', JSON.stringify({ type: 'authenticate' }), JSON.stringify({ type: 'hello' })]) {
    const control = await openControl(ctx.relay.address, generateHostKey());
    await send(control.ws, payload);
    assert.equal((await control.closeInfo).code, 1008);
  }
  const control = await openControl(ctx.relay.address, generateHostKey());
  await send(control.ws, Buffer.from([1, 2, 3]), true);
  assert.equal((await control.closeInfo).code, 1008);
});

test('noncanonical or missing public key is rejected before upgrade', async () => {
  const key = generateHostKey();
  const padded = Buffer.from(key.publicKeyRaw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  await expectRejected(openWs(urls.control(ctx.relay.address, padded)), 400);
  await expectRejected(openWs(urls.control(ctx.relay.address, key.publicKey.slice(0, -1) + 'B')), 400);
  await expectRejected(openWs(urls.control(ctx.relay.address, '')), 400);
  await expectRejected(openWs(`ws://${ctx.relay.address}/v1/control`), 400);
  await expectRejected(openWs(urls.control(ctx.relay.address, Buffer.alloc(31, 7).toString('base64url'))), 400);
});

test('authentication timeout closes the control socket with 1008', async () => {
  const control = await openControl(ctx.relay.address, generateHostKey());
  const start = Date.now();
  assert.equal((await control.closeInfo).code, 1008);
  assert.ok(Date.now() - start < 3000);
});

test('a stolen endpoint claim is rejected and the existing host stays registered', async () => {
  const key = generateHostKey();
  const legit = await connectHost(ctx.relay.address, key);
  const thief = await openControl(ctx.relay.address, key);
  await send(thief.ws, JSON.stringify({ type: 'authenticate', signature: signChallenge(key, thief.nonce) }));
  const close = await thief.closeInfo;
  assert.equal(close.code, 1008);
  assert.equal((await ctx.relay.metrics()).activeHosts, 1);
  const clientPromise = connectClient(ctx.relay.address, key.endpointId);
  const incoming = await legit.nextIncoming();
  assert.equal(typeof incoming.token, 'string');
  const client = await clientPromise;
  client.close(1000);
  await legit.close(1000);
  await ctx.relay.waitMetrics((m) => m.activeHosts === 0 && m.pendingPairs === 0);
});

test('challenge replay is rejected, legitimate reconnect succeeds', async () => {
  const key = generateHostKey();
  const first = await connectHost(ctx.relay.address, key);
  const oldSignature = first.signature;
  await first.close(1000);
  await ctx.relay.waitMetrics((m) => m.activeHosts === 0);

  const replay = await openControl(ctx.relay.address, key);
  assert.notEqual(replay.nonce, first.nonce);
  await send(replay.ws, JSON.stringify({ type: 'authenticate', signature: oldSignature }));
  assert.equal((await replay.closeInfo).code, 1008);

  const second = await connectHost(ctx.relay.address, key);
  assert.equal((await ctx.relay.metrics()).activeHosts, 1);
  await second.close(1000);
  await ctx.relay.waitMetrics((m) => m.activeHosts === 0);
});

test('a second authenticate on the same socket after a failed attempt is rejected', async () => {
  const key = generateHostKey();
  const control = await openControl(ctx.relay.address, key);
  const good = signChallenge(key, control.nonce);
  await send(control.ws, JSON.stringify({ type: 'authenticate', signature: good.slice(0, -2) + 'AA' }));
  const closeInfo = trackClose(control.ws);
  try { await send(control.ws, JSON.stringify({ type: 'authenticate', signature: good })); } catch {}
  assert.equal((await closeInfo).code, 1008);
  assert.equal((await ctx.relay.metrics()).activeHosts, 0);
});
