import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acceptUrl, closePair, deadline, echo, echoHost, host, identity, pair, pending, rejected, send, signature, socket, startRelay } from './support.mjs';

async function fixture(t, env) {
  const relay = await startRelay(env);
  t.after(() => relay.stop());
  return relay;
}

async function closed(h, p) {
  const event = await h.ws.inbox.json('closed');
  assert.equal(event.connectionId, p.incoming.connectionId);
  return deadline(p.client.inbox.closed);
}

test('health, authentication, stolen claim, duplicate, replay, and legitimate reconnect', async t => {
  const r = await fixture(t);
  const health = await fetch(`${r.http}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const h = await host(r);
  const p = await pair(r, h);
  echoHost(p);
  await rejected(`${r.ws}/v1/connect?endpointId=${'0'.repeat(64)}`, 404);
  await rejected(`${r.ws}/v1/control?publicKey=${h.keys.publicKey}=`, 400);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alternate = h.keys.publicKey.slice(0, -1) + alphabet[alphabet.indexOf(h.keys.publicKey.at(-1)) + 1];
  assert.deepEqual(Buffer.from(alternate, 'base64url'), Buffer.from(h.keys.publicKey, 'base64url'));
  await rejected(`${r.ws}/v1/control?publicKey=${alternate}`, 400);
  await rejected(`${r.ws}/v1/control`, 400);
  await rejected(`${r.ws}/v1/control?publicKey=${h.keys.publicKey}&publicKey=${h.keys.publicKey}`, 400);
  for (const proof of [undefined, 'invalid', 'stolen', 'duplicate']) {
    const ws = await socket(`${r.ws}/v1/control?publicKey=${h.keys.publicKey}`);
    const c = await ws.inbox.json('challenge');
    const value = proof === 'stolen' ? signature(identity(), c.nonce) : proof === 'duplicate' ? signature(h.keys, c.nonce) : proof;
    ws.send(JSON.stringify({ type: 'authenticate', signature: value }));
    assert.equal((await deadline(ws.inbox.closed)).code, 1008);
    await echo(p, Buffer.from(`still registered ${proof}`));
  }
  const keys = identity();
  const first = await socket(`${r.ws}/v1/control?publicKey=${keys.publicKey}`);
  const second = await socket(`${r.ws}/v1/control?publicKey=${keys.publicKey}`);
  const a = await first.inbox.json('challenge');
  const b = await second.inbox.json('challenge');
  assert.notEqual(a.nonce, b.nonce);
  const proof = signature(keys, a.nonce);
  second.send(JSON.stringify({ type: 'authenticate', signature: proof }));
  assert.equal((await deadline(second.inbox.closed)).code, 1008);
  first.send(JSON.stringify({ type: 'authenticate', signature: proof }));
  await first.inbox.json('registered');
  first.send(JSON.stringify({ type: 'authenticate', signature: proof }));
  assert.equal((await deadline(first.inbox.closed)).code, 1008);
  h.ws.close();
  await deadline(p.client.inbox.closed);
  await deadline(p.accepted.inbox.closed);
  const fresh = await host(r, h.keys);
  const next = await pair(r, fresh);
  echoHost(next);
  await echo(next);
  await closePair(next, fresh);
  assert.ok((await r.metrics()).rejectedConnections >= 8);
  fresh.ws.close();
});

test('complete message type, arbitrary bytes, empty frames, fragmentation, boundaries and application formats', async t => {
  const r = await fixture(t);
  const h = await host(r);
  const p = await pair(r, h);
  const messages = [
    ['', false], [Buffer.alloc(0), true], ['hello', false],
    ['{"type":"hello","session":"example"}', false],
    ['{"type":"e2ee_hello","key":"ordinary application payload"}', false],
    ['<request id="42"><method>status</method></request>', false],
    [Buffer.from(Array.from({ length: 256 }, (_, i) => i)), true],
    [randomBytes(65536), true], ['雪 🦋\u0000', false],
    ...Array.from({ length: 30 }, (_, i) => [`ordered:${i}`, false])
  ];
  for (const [source, target] of [[p.client, p.accepted], [p.accepted, p.client]]) {
    for (const [data, binary] of messages) await send(source, data, binary);
    for (const [data, binary] of messages) {
      const frame = await target.inbox.next();
      assert.equal(frame.binary, binary);
      assert.deepEqual(frame.data, Buffer.from(data));
    }
    source.send('frag', { binary: false, fin: false });
    source.send('mented', { binary: false, fin: true });
    const frame = await target.inbox.next();
    assert.equal(frame.binary, false);
    assert.equal(frame.data.toString(), 'fragmented');
  }
  const result = await closePair(p, h, 4001, 'complete');
  assert.deepEqual(result.accepted, { code: 4001, reason: 'complete' });
  assert.equal(h.ws.inbox.messages.filter(m => JSON.parse(m.data).type === 'closed').length, 0);
  const metrics = await r.metrics();
  assert.equal(metrics.activePairs, 0);
  assert.equal(metrics.pendingPairs, 0);
  assert.equal(metrics.forwardedMessages, messages.length * 2 + 2);
  assert.equal(metrics.forwardedBytes, messages.reduce((n, [data]) => n + Buffer.byteLength(data), 0) * 2 + 20);
});

test('multiple hosts and simultaneous pairs do not cross-deliver; token scopes and generations', async t => {
  const r = await fixture(t);
  const hosts = await Promise.all(Array.from({ length: 3 }, () => host(r)));
  const pairs = [];
  for (const h of hosts) for (let i = 0; i < 4; i++) pairs.push({ h, p: await pair(r, h) });
  await Promise.all(pairs.map(async ({ p }, i) => {
    for (let j = 0; j < 8; j++) {
      const text = `pair:${i}:message:${j}`;
      await send(p.client, text);
      assert.equal((await p.accepted.inbox.next()).data.toString(), text);
      await send(p.accepted, `reply:${text}`);
      assert.equal((await p.client.inbox.next()).data.toString(), `reply:${text}`);
    }
  }));
  const waiting = await pending(r, hosts[0]);
  await rejected(acceptUrl(r, hosts[1], waiting.incoming), 403);
  await rejected(acceptUrl(r, hosts[0], { ...waiting.incoming, token: randomBytes(32).toString('base64url') }), 403);
  await rejected(acceptUrl(r, hosts[0], { ...waiting.incoming, token: '' }), 403);
  await rejected(acceptUrl(r, hosts[0], { ...waiting.incoming, token: `${waiting.incoming.token}=` }), 403);
  waiting.accepted = await socket(acceptUrl(r, hosts[0], waiting.incoming));
  await rejected(acceptUrl(r, hosts[0], waiting.incoming), 403);
  await closePair(waiting, hosts[0]);
  const stale = await pending(r, hosts[0]);
  hosts[0].ws.terminate();
  await deadline(stale.client.inbox.closed);
  const fresh = await host(r, hosts[0].keys);
  const next = await pair(r, fresh);
  await rejected(acceptUrl(r, fresh, stale.incoming), 403);
  for (const { h, p } of pairs) {
    if (h === hosts[0]) await deadline(p.client.inbox.closed);
    else await closePair(p, h);
  }
  echoHost(next);
  await echo(next, 'new generation survives old cleanup');
  await closePair(next, fresh);
});

test('pending messages preserve order, time out, and reject expired tokens', async t => {
  const r = await fixture(t, { RELAY_PAIR_TIMEOUT_MS: '350' });
  const h = await host(r);
  const p = await pending(r, h);
  for (const text of ['first', 'second', 'third']) await send(p.client, text);
  p.accepted = await socket(acceptUrl(r, h, p.incoming));
  for (const text of ['first', 'second', 'third']) assert.equal((await p.accepted.inbox.next()).data.toString(), text);
  await closePair(p, h);
  const expired = await pending(r, h);
  assert.equal((await closed(h, expired)).code, 1008);
  await rejected(acceptUrl(r, h, expired.incoming), 403);
  assert.equal((await r.metrics()).pendingPairs, 0);
});

test('pending byte and message queue limits release state', async t => {
  for (const settings of [
    { RELAY_MAX_QUEUE_BYTES: '512', RELAY_MAX_QUEUE_MESSAGES: '256', payload: Buffer.alloc(300), count: 2 },
    { RELAY_MAX_QUEUE_BYTES: '4096', RELAY_MAX_QUEUE_MESSAGES: '3', payload: Buffer.alloc(0), count: 4 }
  ]) {
    const { payload, count, ...env } = settings;
    const r = await fixture(t, env);
    const h = await host(r);
    const p = await pending(r, h);
    for (let i = 0; i < count; i++) await send(p.client, payload);
    assert.equal((await closed(h, p)).code, 1013);
    await rejected(acceptUrl(r, h, p.incoming), 403);
    assert.equal((await r.metrics()).pendingPairs, 0);
  }
});

test('one-byte data limits leave control authentication and pairing usable', async t => {
  const r = await fixture(t, { RELAY_MAX_MESSAGE_BYTES: '1', RELAY_MAX_QUEUE_BYTES: '1', RELAY_MAX_QUEUE_MESSAGES: '1' });
  const h = await host(r);
  const p = await pair(r, h);
  echoHost(p);
  await echo(p, Buffer.from([255]));
  await closePair(p, h);
});

test('oversize complete and fragmented messages close both peers with 1009', async t => {
  const r = await fixture(t, { RELAY_MAX_MESSAGE_BYTES: '1024' });
  const h = await host(r);
  for (const fragmented of [false, true]) {
    const p = await pair(r, h);
    if (fragmented) {
      p.client.send(Buffer.alloc(700), { fin: false });
      p.client.send(Buffer.alloc(700), { fin: true });
    } else p.client.send(Buffer.alloc(1025));
    assert.equal((await closed(h, p)).code, 1009);
    assert.equal((await deadline(p.accepted.inbox.closed)).code, 1009);
  }
});

test('global, per-host, pending and control admission limits', async t => {
  const r = await fixture(t, { RELAY_MAX_CLIENTS: '3', RELAY_MAX_CLIENTS_PER_HOST: '2', RELAY_MAX_PENDING_PER_HOST: '1' });
  const h = await host(r);
  const other = await host(r);
  const waiting = await pending(r, h);
  await rejected(`${r.ws}/v1/connect?endpointId=${h.endpointId}`, 429);
  waiting.accepted = await socket(acceptUrl(r, h, waiting.incoming));
  const second = await pair(r, h);
  await rejected(`${r.ws}/v1/connect?endpointId=${h.endpointId}`, 429);
  const third = await pair(r, other);
  await rejected(`${r.ws}/v1/connect?endpointId=${other.endpointId}`, 429);
  const spare = await host(r);
  await rejected(`${r.ws}/v1/control?publicKey=${identity().publicKey}`, 503);
  await closePair(waiting, h);
  const replacement = await pair(r, other);
  await closePair(replacement, other);
  await closePair(second, h);
  await closePair(third, other);
  spare.ws.close();
});

test('authentication expiry, heartbeat cleanup, and abrupt disconnects', async t => {
  const r = await fixture(t, { RELAY_AUTH_TIMEOUT_MS: '200', RELAY_HEARTBEAT_MS: '120' });
  const unauthenticated = await socket(`${r.ws}/v1/control?publicKey=${identity().publicKey}`);
  await unauthenticated.inbox.json('challenge');
  assert.equal((await deadline(unauthenticated.inbox.closed)).code, 1008);
  const h = await host(r);
  const silent = await pair(r, h, { autoPong: false });
  assert.equal((await closed(h, silent)).code, 1001);
  assert.equal((await deadline(silent.accepted.inbox.closed)).code, 1001);
  const abrupt = await pair(r, h);
  abrupt.accepted.terminate();
  assert.equal((await closed(h, abrupt)).code, 1011);
  const silentHost = await host(r, identity(), { autoPong: false });
  const pendingHost = await pending(r, silentHost);
  assert.equal((await deadline(silentHost.ws.inbox.closed)).code, 1001);
  await deadline(pendingHost.client.inbox.closed);
  assert.equal((await r.metrics()).activePairs, 0);
});

test('per-IP admission rate rejects bursts and ignores forwarded IP headers', async t => {
  const r = await fixture(t, { RELAY_ADMISSION_RATE: '2' });
  const keys = identity();
  const status = await Promise.all(Array.from({ length: 12 }, (_, i) => {
    const url = `${r.http}/v1/connect?endpointId=${keys.endpointId}`;
    return fetch(url, { headers: { 'x-forwarded-for': `192.0.2.${i}` } }).then(response => response.status);
  }));
  assert.ok(status.filter(value => value === 429).length >= 10);
  assert.equal((await r.metrics()).admissionIPs, 1);
});

test('stalled readers hit bounded queues while another pair remains usable', async t => {
  const r = await fixture(t, { RELAY_MAX_QUEUE_BYTES: '262144', RELAY_MAX_QUEUE_MESSAGES: '8', RELAY_WRITE_TIMEOUT_MS: '250', RELAY_HEARTBEAT_MS: '10000' });
  const h = await host(r);
  const slow = await pair(r, h);
  const healthy = await pair(r, h);
  echoHost(healthy);
  slow.accepted._socket.pause();
  t.after(() => slow.accepted.terminate());
  const released = h.ws.inbox.json('closed');
  const flood = (async () => {
    for (let i = 0; i < 512 && slow.client.readyState === 1; i++) {
      try { await send(slow.client, Buffer.alloc(65536, i % 256)); } catch { break; }
      await echo(healthy, Buffer.from(`healthy:${i}`));
    }
  })();
  assert.equal((await released).connectionId, slow.incoming.connectionId);
  const ending = await deadline(slow.client.inbox.closed);
  assert.equal(ending.code, 1013);
  await flood;
  slow.accepted._socket.resume();
  await closePair(healthy, h);
  assert.equal((await r.metrics()).activePairs, 0);
});

test('write deadline releases a stalled direction below its configured queue limit', async t => {
  const r = await fixture(t, { RELAY_MAX_QUEUE_BYTES: '8388608', RELAY_MAX_QUEUE_MESSAGES: '256', RELAY_WRITE_TIMEOUT_MS: '150', RELAY_HEARTBEAT_MS: '10000' });
  const h = await host(r);
  const p = await pair(r, h);
  p.accepted._socket.pause();
  t.after(() => p.accepted.terminate());
  for (let i = 0; i < 64; i++) {
    try { await send(p.client, Buffer.alloc(65536)); } catch { break; }
  }
  const end = await closed(h, p);
  assert.equal(end.code, 1013);
  assert.equal(end.reason, 'write timeout');
  p.accepted._socket.resume();
});

test('SIGTERM rejects admissions, preserves active traffic, then closes within five seconds', async t => {
  const r = await fixture(t);
  const h = await host(r);
  const p = await pair(r, h);
  echoHost(p);
  const draining = once(r.events, 'draining');
  const waiting = await pending(r, h);
  const started = performance.now();
  r.child.kill('SIGTERM');
  await deadline(draining);
  assert.equal((await fetch(`${r.http}/healthz`)).status, 503);
  await rejected(`${r.ws}/v1/connect?endpointId=${h.endpointId}`, 503);
  await rejected(`${r.ws}/v1/control?publicKey=${identity().publicKey}`, 503);
  await rejected(acceptUrl(r, h, waiting.incoming), 503);
  await echo(p, 'finishing work');
  assert.equal((await deadline(p.client.inbox.closed, 6000)).code, 1001);
  assert.equal((await deadline(waiting.client.inbox.closed)).code, 1001);
  assert.equal((await deadline(r.exited, 2000)).code, 0);
  assert.ok(performance.now() - started < 5500);
  assert.equal(r.stdout.length, 1);
  assert.ok(!r.stderr.join('\n').includes(p.incoming.token));
});

test('SIGTERM finishes early after the last pair closes', async t => {
  const r = await fixture(t);
  const h = await host(r);
  const p = await pair(r, h);
  const draining = once(r.events, 'draining');
  r.child.kill('SIGTERM');
  await draining;
  await closePair(p, h);
  assert.equal((await deadline(r.exited, 2000)).code, 0);
});

test('invalid configuration exits without a listening record', async () => {
  const child = spawn('bash', [fileURLToPath(new URL('../run.sh', import.meta.url))], {
    env: { ...process.env, RELAY_ADDR: '127.0.0.1:0', RELAY_MAX_CLIENTS: '-2' }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  try {
    const [code] = await deadline(once(child, 'exit'), 10000);
    assert.notEqual(code, 0);
    assert.ok(!stdout.includes('listening'));
    assert.ok(stderr.includes('invalid RELAY_MAX_CLIENTS'));
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});
