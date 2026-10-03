import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useRelay } from './helpers.mjs';
import { generateHostKey } from '../lib/protocol.mjs';
import { connectHost, pair } from '../lib/host.mjs';
import { send, trackClose } from '../lib/ws.mjs';

const ctx = useRelay(test);

async function pairedWithQueues(relay, host) {
  const { client, hostSocket, incoming } = await pair(relay, host);
  return { client, hostSocket, incoming, clientQ: client.queue, hostQ: hostSocket.queue };
}

test('text, binary and empty payloads cross both directions unchanged with type preserved', async () => {
  const host = await connectHost(ctx.relay.address, generateHostKey());
  const { client, hostSocket, clientQ, hostQ } = await pairedWithQueues(ctx.relay, host);
  const bin = crypto.randomBytes(3001);
  const cases = [
    ['hello world', false],
    [bin, true],
    ['', false],
    [Buffer.alloc(0), true],
    [Buffer.from([0xff, 0xfe, 0x00, 0x80]), true],
    ['unicode ✓ ☃ 🎉', false],
  ];
  for (const [payload, binary] of cases) {
    await send(client, payload, binary);
    const got = await hostQ.next();
    assert.equal(got.isBinary, binary);
    assert.deepEqual(got.data, Buffer.from(payload));
    await send(hostSocket, payload, binary);
    const back = await clientQ.next();
    assert.equal(back.isBinary, binary);
    assert.deepEqual(back.data, Buffer.from(payload));
  }
  const m = await ctx.relay.metrics();
  assert.equal(m.forwardedMessages, cases.length * 2);
  client.close(1000);
  await host.close(1000);
});

test('message boundaries and order are preserved for a burst in both directions', async () => {
  const host = await connectHost(ctx.relay.address, generateHostKey());
  const { client, hostSocket, clientQ, hostQ } = await pairedWithQueues(ctx.relay, host);
  const count = 300;
  const outbound = Array.from({ length: count }, (_, i) => {
    const size = (i * 977) % 5000;
    if (i % 3 === 0) return [Buffer.from(`t${i}:${'x'.repeat(size % 100)}`), false];
    return [Buffer.concat([Buffer.from(String(i)), crypto.randomBytes(size)]), true];
  });
  for (const [payload, binary] of outbound) client.send(payload, { binary });
  for (const [payload, binary] of outbound) hostSocket.send(payload, { binary });
  for (let i = 0; i < count; i++) {
    const [payload, binary] = outbound[i];
    const got = await hostQ.next();
    assert.equal(got.isBinary, binary, `host message ${i} type`);
    assert.deepEqual(got.data, Buffer.from(payload), `host message ${i} content`);
    const back = await clientQ.next();
    assert.equal(back.isBinary, binary, `client message ${i} type`);
    assert.deepEqual(back.data, Buffer.from(payload), `client message ${i} content`);
  }
  client.close(1000);
  await host.close(1000);
});

test('payloads that look like relay or handshake JSON are forwarded verbatim', async () => {
  const host = await connectHost(ctx.relay.address, generateHostKey());
  const { client, hostSocket, clientQ, hostQ } = await pairedWithQueues(ctx.relay, host);
  const payloads = [
    JSON.stringify({ type: 'hello', version: 1, publicKey: 'abc' }),
    JSON.stringify({ type: 'e2ee_hello', ephemeral: 'xyz', nonce: 'nnn' }),
    JSON.stringify({ type: 'challenge', nonce: 'fake' }),
    JSON.stringify({ type: 'authenticate', signature: 'fake' }),
    JSON.stringify({ type: 'incoming', connectionId: 'x', token: 'y' }),
    JSON.stringify({ type: 'closed', connectionId: 'x' }),
    JSON.stringify({ type: 'registered', endpointId: host.key.endpointId }),
  ];
  for (const p of payloads) {
    await send(client, p, false);
    assert.equal((await hostQ.next()).data.toString(), p);
    await send(hostSocket, p, false);
    assert.equal((await clientQ.next()).data.toString(), p);
  }
  assert.equal(host.incoming.length, 0);
  client.close(1000);
  await host.close(1000);
});

test('closing the client closes the host data socket and notifies control exactly once', async () => {
  const host = await connectHost(ctx.relay.address, generateHostKey());
  const { client, hostSocket, incoming } = await pairedWithQueues(ctx.relay, host);
  const hostClose = trackClose(hostSocket);
  client.close(1000, 'bye');
  const close = await hostClose;
  assert.equal(close.code, 1000);
  const closed = await host.nextClosed();
  assert.equal(closed.connectionId, incoming.connectionId);
  await ctx.relay.waitMetrics((m) => m.activePairs === 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(host.closedEvents.length, 0);
  await host.close(1000);
});

test('an abrupt client disconnect maps to a legal 1001 on the host side', async () => {
  const host = await connectHost(ctx.relay.address, generateHostKey());
  const { client, hostSocket, incoming } = await pairedWithQueues(ctx.relay, host);
  const hostClose = trackClose(hostSocket);
  client._socket.destroy();
  const close = await hostClose;
  assert.equal(close.code, 1001);
  assert.equal((await host.nextClosed()).connectionId, incoming.connectionId);
  await host.close(1000);
});

test('closing the host data socket closes the client', async () => {
  const host = await connectHost(ctx.relay.address, generateHostKey());
  const { client, hostSocket, incoming } = await pairedWithQueues(ctx.relay, host);
  const clientClose = trackClose(client);
  hostSocket.close(1000, 'host done');
  assert.equal((await clientClose).code, 1000);
  assert.equal((await host.nextClosed()).connectionId, incoming.connectionId);
  await host.close(1000);
});

test('closing the control socket closes every pending and active pair for that host', async () => {
  const host = await connectHost(ctx.relay.address, generateHostKey());
  const active = await pairedWithQueues(ctx.relay, host);
  const pendingClient = await (await import('../lib/host.mjs')).connectClient(ctx.relay.address, host.key.endpointId);
  await host.nextIncoming();
  const closes = Promise.all([trackClose(active.client), trackClose(active.hostSocket), trackClose(pendingClient)]);
  await host.close(1000);
  for (const c of await closes) assert.equal(c.code, 1001);
  await ctx.relay.waitMetrics((m) => m.activePairs === 0 && m.pendingPairs === 0 && m.activeHosts === 0);
});
