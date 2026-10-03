import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useRelay, expectRejected } from './helpers.mjs';
import { generateHostKey } from '../lib/protocol.mjs';
import { connectHost, connectClient } from '../lib/host.mjs';
import { send, trackClose } from '../lib/ws.mjs';

const ctx = useRelay(test);

test('three hosts with four simultaneous clients each never cross-deliver', async () => {
  const hosts = await Promise.all([0, 1, 2].map(() => connectHost(ctx.relay.address, generateHostKey())));
  const pairs = [];
  for (const [h, host] of hosts.entries()) {
    const clients = await Promise.all([0, 1, 2, 3].map(() => connectClient(ctx.relay.address, host.key.endpointId)));
    const accepted = [];
    for (let i = 0; i < 4; i++) accepted.push(await host.acceptNext());
    pairs.push({ host, h, clients, accepted });
  }
  const hostQueues = new Map();
  for (const { accepted } of pairs) for (const { socket, incoming } of accepted) hostQueues.set(incoming.connectionId, { q: socket.queue, socket });
  const clientQueues = pairs.flatMap(({ clients }) => clients.map((c) => c.queue));

  await Promise.all(pairs.flatMap(({ clients, h }) => clients.map((c, i) => send(c, `from host${h} client${i}`))));
  const seen = new Map();
  for (const [connectionId, { q, socket }] of hostQueues) {
    const { data } = await q.next();
    seen.set(connectionId, data.toString());
    await send(socket, `reply to ${data.toString()}`);
  }
  const values = [...seen.values()].sort();
  assert.deepEqual(values, pairs.flatMap(({ h }) => [0, 1, 2, 3].map((i) => `from host${h} client${i}`)).sort());

  let idx = 0;
  for (const { clients, h } of pairs) {
    for (let i = 0; i < clients.length; i++) {
      const { data } = await clientQueues[idx++].next();
      assert.equal(data.toString(), `reply to from host${h} client${i}`);
    }
  }
  const m = await ctx.relay.metrics();
  assert.equal(m.activeHosts, 3);
  assert.equal(m.activePairs, 12);
  for (const { host } of pairs) await host.close(1000);
  await ctx.relay.waitMetrics((m) => m.activeHosts === 0 && m.activePairs === 0);
});

test('wrong, reused, foreign and unknown data tokens are rejected before upgrade', async () => {
  const hostA = await connectHost(ctx.relay.address, generateHostKey());
  const hostB = await connectHost(ctx.relay.address, generateHostKey());
  const clientPromise = connectClient(ctx.relay.address, hostA.key.endpointId);
  const incoming = await hostA.nextIncoming();

  await expectRejected(hostA.accept(incoming, { token: Buffer.alloc(32, 1).toString('base64url') }), 403);
  await expectRejected(hostA.accept(incoming, { token: incoming.token + '=' }), 403);
  await expectRejected(hostA.accept(incoming, { token: '' }), 403);
  await expectRejected(hostA.accept(incoming, { connectionId: Buffer.alloc(16, 2).toString('base64url') }), 404);
  await expectRejected(hostA.accept(incoming, { connectionId: 'short' }), 404);
  await expectRejected(hostB.accept(incoming), 404);
  await expectRejected(hostA.accept(incoming, { endpointId: 'zz'.repeat(32) }), 400);

  const hostSocket = await hostA.accept(incoming);
  const client = await clientPromise;
  await expectRejected(hostA.accept(incoming), 403);
  await send(client, 'still works');
  const hostQ = hostSocket.queue;
  assert.equal((await hostQ.next()).data.toString(), 'still works');
  const m = await ctx.relay.metrics();
  assert.ok(m.rejectedConnections >= 8);
  await hostA.close(1000);
  await hostB.close(1000);
  await ctx.relay.waitMetrics((m) => m.activeHosts === 0 && m.activePairs === 0);
});

test('a reconnected host cannot accept a pair from its previous registration generation', async () => {
  const key = generateHostKey();
  const first = await connectHost(ctx.relay.address, key);
  const client = await connectClient(ctx.relay.address, key.endpointId);
  const incoming = await first.nextIncoming();
  const clientClose = trackClose(client);
  await first.close(1000);
  assert.equal((await clientClose).code, 1001);
  await ctx.relay.waitMetrics((m) => m.activeHosts === 0 && m.pendingPairs === 0);

  const second = await connectHost(ctx.relay.address, key);
  await expectRejected(second.accept(incoming), 404);
  const fresh = connectClient(ctx.relay.address, key.endpointId);
  const { socket } = await second.acceptNext();
  const freshClient = await fresh;
  await send(freshClient, 'new generation');
  assert.equal((await socket.queue.next()).data.toString(), 'new generation');
  await second.close(1000);
  await ctx.relay.waitMetrics((m) => m.activeHosts === 0 && m.activePairs === 0);
});
