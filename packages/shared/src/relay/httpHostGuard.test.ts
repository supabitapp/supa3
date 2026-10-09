// @effect-diagnostics nodeBuiltinImport:off - verifies bounded streaming through the native HTTP guard.
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import { expect, it } from "vite-plus/test";
import { HttpHostGuard } from "./httpHostGuard.ts";

const authority = "127.0.0.1:40000";
const upgrade = `GET /ws HTTP/1.1\r\nHost: ${authority}\r\nUpgrade: websocket\r\n\r\n`;

it("strips cookie variants on every request without changing headers or bodies", async () => {
  const first = `POST /upload HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: Bearer synthetic\r\nX-Name: café\r\nContent-Length: 3\r\n`;
  const second = `POST /next HTTP/1.1\r\nHost: ${authority}\r\nTransfer-Encoding: chunked\r\n`;
  const input = Buffer.from(
    first +
      "cOoKiE: first=secret\r\nCookie: second=secret\r\nCOOKIE2: old=secret\r\n\r\nabc" +
      second +
      "Cookie: third=secret\r\n\r\n3\r\nxyz\r\n0\r\n\r\n",
    "latin1",
  );
  const expected = Buffer.from(first + "\r\nabc" + second + "\r\n3\r\nxyz\r\n0\r\n\r\n", "latin1");
  for (const size of [1, input.length]) {
    const guard = new HttpHostGuard(authority);
    const received: Buffer[] = [];
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.from(
        (function* () {
          for (let offset = 0; offset < input.length; offset += size)
            yield input.subarray(offset, offset + size);
        })(),
      ),
      guard,
      new NodeStream.Writable({
        write(bytes: Buffer, _encoding, callback) {
          received.push(bytes);
          callback();
        },
      }),
    );
    expect(Buffer.concat(received)).toEqual(expected);
  }
});

it("waits through fragmented interim responses before releasing opaque upgrade bytes", async () => {
  const guard = new HttpHostGuard(authority);
  const output: Buffer[] = [];
  guard.on("data", (bytes: Buffer) => output.push(bytes));
  const payload = "GET /foreign HTTP/1.1\r\nHost: elsewhere.invalid\r\n\r\n";
  const finished = new Promise<void>((resolve, reject) => {
    guard.once("end", resolve);
    guard.once("error", reject);
  });
  guard.end(upgrade + payload);
  expect(Buffer.concat(output).toString()).toBe(upgrade);
  for (const byte of Buffer.from("HTTP/1.1 103 Early Hints\r\n\r\n"))
    guard.observeResponse(Buffer.from([byte]));
  expect(Buffer.concat(output).toString()).toBe(upgrade);
  for (const byte of Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n"))
    guard.observeResponse(Buffer.from([byte]));
  await finished;
  expect(Buffer.concat(output).toString()).toBe(upgrade + payload);
});

it("backpressures a large upload when the receiver stops reading", async () => {
  const size = 64 * 1024 * 1024;
  const block = Buffer.alloc(32 * 1024, 7);
  const head = Buffer.from(
    `POST /upload HTTP/1.1\r\nHost: ${authority}\r\nContent-Length: ${size}\r\n\r\n`,
  );
  let produced = 0;
  const source = NodeStream.Readable.from(
    (function* () {
      yield head;
      for (let offset = 0; offset < size; offset += block.length) {
        produced++;
        yield block;
      }
    })(),
    { objectMode: false },
  );
  const stalled = Promise.withResolvers<NodeStream.TransformCallback>();
  let received = 0;
  const sink = new NodeStream.Writable({
    write(bytes: Buffer, _encoding, callback) {
      received += bytes.length;
      if (received === head.length) stalled.resolve(callback);
      else callback();
    },
  });
  const guard = new HttpHostGuard(authority);
  const transferred = NodeStreamPromises.pipeline(source, guard, sink);
  const resume = await stalled.promise;
  expect(produced).toBeLessThan(10);
  expect(guard.readableLength + guard.writableLength).toBeLessThan(256 * 1024);
  resume();
  await transferred;
  expect(received).toBe(size + head.length);
});
