import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useRelay } from './helpers.mjs';
import { generateHostKey } from '../lib/protocol.mjs';
import { connectHost, pair } from '../lib/host.mjs';
import { send } from '../lib/ws.mjs';

const ctx = useRelay(test);

function encodeRecord(fields) {
  const parts = [Buffer.from('PRL1')];
  for (const [tag, value] of fields) {
    const header = Buffer.alloc(5);
    header.writeUInt8(tag, 0);
    header.writeUInt32LE(value.length, 1);
    parts.push(header, value);
  }
  return Buffer.concat(parts);
}

function decodeRecord(buf) {
  assert.equal(buf.subarray(0, 4).toString(), 'PRL1');
  const fields = [];
  let offset = 4;
  while (offset < buf.length) {
    const tag = buf.readUInt8(offset);
    const len = buf.readUInt32LE(offset + 1);
    fields.push([tag, buf.subarray(offset + 5, offset + 5 + len)]);
    offset += 5 + len;
  }
  return fields;
}

test('a JSON-RPC style text protocol and a binary tagged-field protocol share one relay unchanged', async () => {
  const host = await connectHost(ctx.relay.address, generateHostKey());
  const rpc = await pair(ctx.relay, host);
  const bin = await pair(ctx.relay, host);

  const request = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'sum', params: [1, 2, 3] });
  await send(rpc.client, request);
  const seenRequest = (await rpc.hostSocket.queue.next()).data.toString();
  assert.equal(seenRequest, request);
  const parsed = JSON.parse(seenRequest);
  await send(rpc.hostSocket, JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: parsed.params.reduce((a, b) => a + b, 0) }));
  assert.deepEqual(await rpc.client.queue.nextJson(), { jsonrpc: '2.0', id: 7, result: 6 });

  const record = encodeRecord([[1, Buffer.from('frame-0001')], [2, Buffer.from([0, 0, 0, 0, 255, 1, 2, 3])], [9, Buffer.alloc(0)]]);
  await send(bin.client, record, true);
  const got = await bin.hostSocket.queue.next();
  assert.equal(got.isBinary, true);
  assert.deepEqual(got.data, record);
  const fields = decodeRecord(got.data);
  assert.equal(fields[0][1].toString(), 'frame-0001');
  const reply = encodeRecord([[1, Buffer.from('ack frame-0001')], [3, Buffer.from([0x7f])]]);
  await send(bin.hostSocket, reply, true);
  const back = await bin.client.queue.next();
  assert.equal(back.isBinary, true);
  assert.deepEqual(back.data, reply);

  await host.close(1000);
});
