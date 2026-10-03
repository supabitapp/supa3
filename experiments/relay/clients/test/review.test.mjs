import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../lib/relay.mjs';
import { expectRejected } from './helpers.mjs';
import { generateHostKey } from '../lib/protocol.mjs';
import { connectHost, connectClient, pair } from '../lib/host.mjs';
import { send, trackClose } from '../lib/ws.mjs';

async function withRelay(env, fn) {
  const relay = await startRelay(env);
  try { await fn(relay); } finally { await relay.stop(); }
}

test('a legal peer close code and reason are preserved end to end in both directions', () => withRelay({}, async (relay) => {
  const host = await connectHost(relay.address, generateHostKey());
  const first = await pair(relay, host);
  const firstHostClose = trackClose(first.hostSocket);
  first.client.close(1000, 'finished');
  assert.deepEqual(await firstHostClose, { code: 1000, reason: 'finished' });

  const second = await pair(relay, host);
  const secondClientClose = trackClose(second.client);
  second.hostSocket.close(4001, 'application says goodbye');
  assert.deepEqual(await secondClientClose, { code: 4001, reason: 'application says goodbye' });

  const third = await pair(relay, host);
  const thirdHostClose = trackClose(third.hostSocket);
  third.client.close();
  assert.deepEqual(await thirdHostClose, { code: 1000, reason: '' });
  await host.close(1000);
}));

test('a one byte message limit still allows control authentication and one byte payloads', () => withRelay({ RELAY_MAX_MESSAGE_BYTES: '1', RELAY_MAX_QUEUE_BYTES: '1024' }, async (relay) => {
  const host = await connectHost(relay.address, generateHostKey());
  const { client, hostSocket } = await pair(relay, host);
  await send(client, Buffer.from([0x2a]), true);
  const got = await hostSocket.queue.next();
  assert.deepEqual(got.data, Buffer.from([0x2a]));
  await send(hostSocket, 'x');
  assert.equal((await client.queue.next()).data.toString(), 'x');
  const clientClose = trackClose(client);
  await send(client, 'xy');
  assert.equal((await clientClose).code, 1009);
  await host.close(1000);
}));

