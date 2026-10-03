import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useRelay } from './helpers.mjs';
import { generateHostKey } from '../lib/protocol.mjs';
import { connectHost, connectClient } from '../lib/host.mjs';
import { trackClose } from '../lib/ws.mjs';
import { makeTestIdentity, serveTls, connectTls, tlsRequest } from '../lib/tls.mjs';

const ctx = useRelay(test);
const hostIdentity = makeTestIdentity('passio-test-host');
const impostorIdentity = makeTestIdentity('passio-test-host');

async function startHost(identity) {
  const host = await connectHost(ctx.relay.address, generateHostKey());
  const served = [];
  host.serveLoop = (async () => {
    for (;;) {
      let incoming;
      try { incoming = await host.nextIncoming(60_000); } catch { return; }
      const socket = await host.accept(incoming);
      served.push(serveTls(socket, identity, (req) => Buffer.from(`echo:${req.toString()}`)));
    }
  })();
  host.served = served;
  return host;
}

test('encrypted request/response succeeds through the relay, which only sees ciphertext', async () => {
  const host = await startHost(hostIdentity);
  const ws = await connectClient(ctx.relay.address, host.key.endpointId);
  const observed = [];
  ws.on('message', (data) => observed.push(Buffer.from(data)));
  const tlsSocket = await connectTls(ws, hostIdentity);
  assert.equal(tlsSocket.getProtocol(), 'TLSv1.3');
  const secret = `secret-${Math.random()}`;
  const response = await tlsRequest(tlsSocket, secret);
  assert.equal(response.toString(), `echo:${secret}`);
  assert.ok(!Buffer.concat(observed).includes(Buffer.from(secret)), 'plaintext must not appear on the wire');
  const m = await ctx.relay.metrics();
  assert.ok(m.forwardedMessages > 0);
  tlsSocket.destroy();
  await host.close(1000);
});

test('a host presenting the wrong identity is rejected by the pinning client', async () => {
  const host = await startHost(impostorIdentity);
  const ws = await connectClient(ctx.relay.address, host.key.endpointId);
  await assert.rejects(connectTls(ws, hostIdentity), (err) => /fingerprint mismatch|self[- ]signed|unable to verify/i.test(err.message));
  ws.terminate();
  await host.close(1000);
});

test('modified ciphertext is rejected', async () => {
  const host = await startHost(hostIdentity);
  const ws = await connectClient(ctx.relay.address, host.key.endpointId);
  const state = { tamper: false };
  const tlsSocket = await connectTls(ws, hostIdentity, {
    intercept: (chunk) => {
      if (!state.tamper) return [chunk];
      const copy = Buffer.from(chunk);
      copy[copy.length - 1] ^= 0x01;
      return [copy];
    },
  });
  assert.equal((await tlsRequest(tlsSocket, 'before')).toString(), 'echo:before');
  state.tamper = true;
  await assert.rejects(tlsRequest(tlsSocket, 'tampered'), (err) => /bad record mac|decryption failed|ERR_SSL/i.test(err.code ?? err.message));
  ws.terminate();
  await host.close(1000);
});

test('a replayed encrypted record is rejected', async () => {
  const host = await startHost(hostIdentity);
  const ws = await connectClient(ctx.relay.address, host.key.endpointId);
  const state = { capture: false, replay: false, captured: null };
  const tlsSocket = await connectTls(ws, hostIdentity, {
    intercept: (chunk) => {
      if (state.capture) { state.captured = Buffer.from(chunk); state.capture = false; }
      if (state.replay && state.captured) { state.replay = false; return [chunk, state.captured]; }
      return [chunk];
    },
  });
  state.capture = true;
  assert.equal((await tlsRequest(tlsSocket, 'first')).toString(), 'echo:first');
  assert.ok(state.captured, 'captured an encrypted application record');
  state.replay = true;
  const errored = new Promise((resolve) => tlsSocket.once('error', resolve));
  const second = await tlsRequest(tlsSocket, 'second').catch((err) => err);
  const err = second instanceof Error ? second : await errored;
  assert.match(err.code ?? err.message, /bad record mac|decryption failed|ERR_SSL/i);
  ws.terminate();
  await host.close(1000);
});

test('a fresh reconnect negotiates a new session and works again', async () => {
  const host = await startHost(hostIdentity);
  const first = await connectClient(ctx.relay.address, host.key.endpointId);
  const firstTls = await connectTls(first, hostIdentity);
  assert.equal((await tlsRequest(firstTls, 'one')).toString(), 'echo:one');
  const firstClose = trackClose(first);
  firstTls.destroy();
  first.close(1000);
  await firstClose;
  const second = await connectClient(ctx.relay.address, host.key.endpointId);
  const secondTls = await connectTls(second, hostIdentity);
  assert.equal((await tlsRequest(secondTls, 'two')).toString(), 'echo:two');
  assert.notDeepEqual(firstTls.getSession?.(), secondTls.getSession?.());
  secondTls.destroy();
  await host.close(1000);
  await ctx.relay.waitMetrics((m) => m.activePairs === 0 && m.activeHosts === 0);
});
