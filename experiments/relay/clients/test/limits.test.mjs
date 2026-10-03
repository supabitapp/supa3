import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startRelay } from '../lib/relay.mjs';
import { expectRejected } from './helpers.mjs';
import { generateHostKey, urls } from '../lib/protocol.mjs';
import { connectHost, connectClient, pair } from '../lib/host.mjs';
import { send, trackClose, openWs } from '../lib/ws.mjs';
import { openRawWs } from '../lib/rawws.mjs';

async function withRelay(env, fn) {
  const relay = await startRelay(env);
  try { await fn(relay); } finally { await relay.stop(); }
}

test('messages sent before pairing are buffered and drained in order', () => withRelay({}, async (relay) => {
  const host = await connectHost(relay.address, generateHostKey());
  const client = await connectClient(relay.address, host.key.endpointId);
  const incoming = await host.nextIncoming();
  const sent = Array.from({ length: 20 }, (_, i) => (i % 2 ? Buffer.from(`pending ${i}`) : crypto.randomBytes(10 + i)));
  for (const [i, payload] of sent.entries()) await send(client, payload, i % 2 === 0);
  await relay.waitMetrics((m) => m.pendingPairs === 1);
  const hostSocket = await host.accept(incoming);
  const q = hostSocket.queue;
  for (const [i, payload] of sent.entries()) {
    const got = await q.next();
    assert.equal(got.isBinary, i % 2 === 0);
    assert.deepEqual(got.data, payload);
  }
  await host.close(1000);
}));

test('pair timeout closes the waiting client, notifies control and releases state', () => withRelay({ RELAY_PAIR_TIMEOUT_MS: '300' }, async (relay) => {
  const host = await connectHost(relay.address, generateHostKey());
  const client = await connectClient(relay.address, host.key.endpointId);
  const incoming = await host.nextIncoming();
  const close = await trackClose(client);
  assert.equal(close.code, 1001);
  assert.equal((await host.nextClosed()).connectionId, incoming.connectionId);
  await relay.waitMetrics((m) => m.pendingPairs === 0 && m.activePairs === 0);
  await expectRejected(host.accept(incoming), 404);
  await host.close(1000);
}));

test('oversize messages close the pair with 1009', () => withRelay({ RELAY_MAX_MESSAGE_BYTES: '1024' }, async (relay) => {
  const host = await connectHost(relay.address, generateHostKey());
  const { client, hostSocket, incoming } = await pair(relay, host);
  const clientClose = trackClose(client);
  const hostClose = trackClose(hostSocket);
  await send(client, crypto.randomBytes(1024), true);
  assert.deepEqual((await hostSocket.queue.next()).data.length, 1024);
  await send(client, crypto.randomBytes(1025), true);
  assert.equal((await clientClose).code, 1009);
  assert.equal((await hostClose).code, 1009);
  assert.equal((await host.nextClosed()).connectionId, incoming.connectionId);
  await host.close(1000);
}));

test('pending buffer limits close the client with 1013', () => withRelay({ RELAY_MAX_QUEUE_MESSAGES: '4' }, async (relay) => {
  const host = await connectHost(relay.address, generateHostKey());
  const client = await connectClient(relay.address, host.key.endpointId);
  const incoming = await host.nextIncoming();
  const close = trackClose(client);
  for (let i = 0; i < 5; i++) await send(client, `m${i}`).catch(() => {});
  assert.equal((await close).code, 1013);
  assert.equal((await host.nextClosed()).connectionId, incoming.connectionId);
  await relay.waitMetrics((m) => m.pendingPairs === 0);
  await host.close(1000);
}));

test('a stalled reader trips the per-direction queue limit without affecting another pair', () => withRelay({ RELAY_MAX_QUEUE_BYTES: String(256 * 1024), RELAY_WRITE_TIMEOUT_MS: '500' }, async (relay) => {
  const host = await connectHost(relay.address, generateHostKey());
  const slow = await pair(relay, host);
  const healthy = await pair(relay, host);
  const healthyQ = healthy.client.queue;
  slow.client._socket.pause();
  const slowHostClose = trackClose(slow.hostSocket);
  const slowClientClose = trackClose(slow.client);
  const chunk = crypto.randomBytes(64 * 1024);
  const flood = (async () => {
    for (let i = 0; i < 400; i++) {
      if (slow.hostSocket.readyState !== 1) return;
      await send(slow.hostSocket, chunk, true).catch(() => {});
    }
  })();
  const closed = await slowHostClose;
  assert.ok([1013, 1006].includes(closed.code), `flooding sender saw ${closed.code}`);
  await flood;
  for (let i = 0; i < 20; i++) {
    await send(healthy.hostSocket, `tick ${i}`);
    assert.equal((await healthyQ.next(2000)).data.toString(), `tick ${i}`);
  }
  slow.client._socket.resume();
  await slowClientClose;
  assert.equal((await host.nextClosed()).connectionId, slow.incoming.connectionId);
  await relay.waitMetrics((m) => m.activePairs === 1);
  await host.close(1000);
}));

test('global, per-host and pending limits reject admissions with 503', () => withRelay({ RELAY_MAX_CLIENTS: '3', RELAY_MAX_CLIENTS_PER_HOST: '2', RELAY_MAX_PENDING_PER_HOST: '1' }, async (relay) => {
  const hostA = await connectHost(relay.address, generateHostKey());
  const hostB = await connectHost(relay.address, generateHostKey());
  const pendingA = await connectClient(relay.address, hostA.key.endpointId);
  await hostA.nextIncoming();
  await expectRejected(connectClient(relay.address, hostA.key.endpointId), 503);
  const b1 = await pair(relay, hostB);
  const b2 = await pair(relay, hostB);
  await expectRejected(connectClient(relay.address, hostB.key.endpointId), 503);
  pendingA.close(1000);
  await relay.waitMetrics((m) => m.pendingPairs === 0);
  const a1 = await pair(relay, hostA);
  await expectRejected(connectClient(relay.address, hostA.key.endpointId), 503);
  const m = await relay.metrics();
  assert.equal(m.activePairs, 3);
  b1.client.close(1000);
  await relay.waitMetrics((m) => m.activePairs === 2);
  const a2 = await pair(relay, hostA);
  await hostA.close(1000);
  await hostB.close(1000);
  [b2, a1, a2].forEach(({ client }) => client.terminate());
}));

test('per-IP admission rate limiting returns 429 and recovers', () => withRelay({ RELAY_ADMISSION_RATE: '5' }, async (relay) => {
  const host = await connectHost(relay.address, generateHostKey());
  let rejected = 0;
  const clients = [];
  for (let i = 0; i < 12; i++) {
    try { clients.push(await connectClient(relay.address, host.key.endpointId)); } catch (err) { assert.equal(err.status, 429); rejected++; }
  }
  assert.ok(rejected >= 5, `expected rate limit rejections, got ${rejected}`);
  await new Promise((r) => setTimeout(r, 1100));
  clients.push(await connectClient(relay.address, host.key.endpointId));
  clients.forEach((c) => c.terminate());
  await host.close(1000);
}));

test('a data socket that never answers pings is closed within the heartbeat window', () => withRelay({ RELAY_HEARTBEAT_MS: '200' }, async (relay) => {
  const host = await connectHost(relay.address, generateHostKey());
  const idle = await pair(relay, host);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(idle.client.readyState, 1, 'a responsive idle socket survives several heartbeats');
  assert.equal(host.ws.readyState, 1, 'a responsive control socket survives several heartbeats');
  const raw = await openRawWs(urls.connect(relay.address, host.key.endpointId));
  const incoming = await host.nextIncoming();
  const hostSocket = await host.accept(incoming);
  const hostClose = trackClose(hostSocket);
  const start = Date.now();
  const frames = await raw.closed;
  assert.ok(frames.some((f) => f.opcode === 9), 'expected at least one relay ping');
  const closeFrame = frames.find((f) => f.opcode === 8);
  assert.equal(closeFrame.payload.readUInt16BE(0), 1001);
  assert.ok(Date.now() - start < 2000);
  assert.equal((await hostClose).code, 1001);
  assert.equal((await host.nextClosed()).connectionId, incoming.connectionId);
  await relay.waitMetrics((m) => m.activePairs === 1);
  assert.equal(idle.client.readyState, 1);
  await host.close(1000);
}));

test('a host control socket that never answers pings is closed with 1001 and its pairs released', () => withRelay({ RELAY_HEARTBEAT_MS: '200' }, async (relay) => {
  const key = generateHostKey();
  const raw = await openRawWs(urls.control(relay.address, key.publicKey));
  const frames = await raw.closed;
  assert.ok(frames.some((f) => f.opcode === 1), 'challenge was sent');
  assert.equal(frames.find((f) => f.opcode === 8).payload.readUInt16BE(0), 1001);
}));

test('graceful shutdown drains: health 503, admissions stop, active pairs finish, then exit 0', () => withRelay({}, async (relay) => {
  const host = await connectHost(relay.address, generateHostKey());
  const { client, hostSocket } = await pair(relay, host);
  const clientQ = client.queue;
  relay.signal('SIGTERM');
  const deadline = Date.now() + 3000;
  let health;
  while (Date.now() < deadline) {
    health = await relay.healthz().catch(() => null);
    if (health && health.status === 503) break;
  }
  assert.equal(health.status, 503);
  await expectRejected(connectClient(relay.address, host.key.endpointId), 503);
  await expectRejected(openWs(urls.control(relay.address, generateHostKey().publicKey)), 503);
  await send(hostSocket, 'still forwarding during drain');
  assert.equal((await clientQ.next()).data.toString(), 'still forwarding during drain');
  const hostClose = trackClose(hostSocket);
  const controlClose = host.closeInfo;
  client.close(1000, 'finished');
  assert.equal((await hostClose).code, 1000);
  const exit = await relay.exited;
  assert.equal(exit.code, 0);
  assert.equal((await controlClose).code, 1001);
}));

test('graceful shutdown force-closes remaining sockets after the 5 second grace period', () => withRelay({}, async (relay) => {
  const host = await connectHost(relay.address, generateHostKey());
  const { client, hostSocket } = await pair(relay, host);
  const closes = Promise.all([trackClose(client), trackClose(hostSocket), host.closeInfo]);
  const start = Date.now();
  relay.signal('SIGTERM');
  const results = await closes;
  const elapsed = Date.now() - start;
  for (const c of results) assert.equal(c.code, 1001);
  assert.ok(elapsed >= 4500 && elapsed < 8000, `elapsed ${elapsed}ms`);
  assert.equal((await relay.exited).code, 0);
}));
