import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Host, startRelay } from "../lib.js";

function tlv(fields) {
  return Buffer.concat(
    fields.flatMap(([tag, value]) => {
      const header = Buffer.alloc(5);
      header.writeUInt8(tag, 0);
      header.writeUInt32BE(value.length, 1);
      return [header, value];
    }),
  );
}

describe("unrelated application payload formats", () => {
  let relay;
  before(async () => {
    relay = await startRelay();
  });
  after(() => relay.stop());

  test("JSON-RPC text and a binary TLV protocol share the relay unchanged", async () => {
    const host = await Host.register(relay);
    const rpc = await host.pair();
    const bin = await host.pair();
    rpc.data.ws.on("message", (msg) => {
      const req = JSON.parse(msg.toString());
      rpc.data.ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.params.reduce((a, b) => a + b, 0) }));
    });
    bin.data.ws.on("message", (msg) => {
      const buf = Buffer.from(msg);
      bin.data.ws.send(Buffer.concat([buf, tlv([[0xff, crypto.createHash("sha256").update(buf).digest()]])]));
    });
    await Promise.all([
      (async () => {
        for (let id = 1; id <= 100; id++) {
          await rpc.client.send(JSON.stringify({ jsonrpc: "2.0", id, method: "sum", params: [id, id * 2, 3] }));
          const reply = await rpc.client.next();
          assert.equal(reply.isBinary, false);
          assert.deepEqual(JSON.parse(reply.data.toString()), { jsonrpc: "2.0", id, result: id * 3 + 3 });
        }
      })(),
      (async () => {
        for (let i = 0; i < 100; i++) {
          const frame = tlv([[1, Buffer.from(`record-${i}`)], [2, crypto.randomBytes(i * 37)], [3, Buffer.alloc(0)]]);
          await bin.client.send(frame, { binary: true });
          const reply = await bin.client.next();
          assert.equal(reply.isBinary, true);
          assert.deepEqual(reply.data.subarray(0, frame.length), frame);
          assert.deepEqual(reply.data.subarray(frame.length + 5), crypto.createHash("sha256").update(frame).digest());
        }
      })(),
    ]);
    await rpc.client.close(1000);
    await bin.client.close(1000);
    await host.close();
  });
});
