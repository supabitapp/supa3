import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { after, before, describe, test } from "node:test";
import { Host, connect, deadline, startRelay } from "../lib.js";

const SERVERNAME = "passio-test-host";

function makeCert(dir, name) {
  const key = path.join(dir, `${name}.key`);
  const cert = path.join(dir, `${name}.crt`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${SERVERNAME}`,
    "-addext", `subjectAltName=DNS:${SERVERNAME}`,
  ], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function wsStream(conn) {
  const wire = { sent: [], received: [], mutate: null };
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      const out = wire.mutate ? wire.mutate(Buffer.from(chunk)) : chunk;
      wire.sent.push(Buffer.from(out));
      conn.ws.send(out, { binary: true }, callback);
    },
  });
  conn.pipe(({ data }) => {
    wire.received.push(data);
    stream.push(data);
  });
  conn.ws.on("close", () => stream.push(null));
  stream.wire = wire;
  return stream;
}

function serveTls(host, identity) {
  const sessions = [];
  const server = tls.createServer({ ...identity, minVersion: "TLSv1.3" });
  server.on("secureConnection", (socket) => {
    const session = sessions.find((s) => !s.socket);
    session.socket = socket;
    socket.on("error", (err) => session.fail(err));
    socket.on("close", () => session.fail(session.error ?? new Error("closed")));
    socket.on("data", (chunk) => {
      session.plaintext.push(chunk.toString());
      socket.write(`reply:${chunk}`);
    });
  });
  server.on("tlsClientError", (err) => sessions.find((s) => !s.socket)?.fail(err));
  (async () => {
    for (;;) {
      let incoming;
      try {
        incoming = await host.incoming(1e9);
      } catch {
        return;
      }
      const data = await host.accept(incoming);
      const stream = wsStream(data);
      const session = { plaintext: [], error: null, wire: stream.wire, stream, socket: null };
      session.failed = new Promise((resolve) => {
        session.fail = (err) => {
          session.error ??= err;
          resolve(session.error);
        };
      });
      sessions.push(session);
      server.emit("connection", stream);
    }
  })();
  return sessions;
}

async function openTls(relay, host, pinned) {
  const conn = await connect(`${relay.ws}/v1/connect?endpointId=${host.endpointId}`);
  const stream = wsStream(conn);
  const fingerprint = new crypto.X509Certificate(pinned).fingerprint256;
  const socket = tls.connect({
    socket: stream,
    servername: SERVERNAME,
    ca: [pinned],
    minVersion: "TLSv1.3",
    checkServerIdentity: (name, cert) =>
      tls.checkServerIdentity(name, cert) ??
      (cert.fingerprint256 === fingerprint ? undefined : new Error("pinned certificate mismatch")),
  });
  const ready = new Promise((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  const replies = [];
  const waiters = [];
  socket.on("data", (chunk) => {
    const waiter = waiters.shift();
    if (waiter) waiter(chunk.toString());
    else replies.push(chunk.toString());
  });
  return {
    conn,
    socket,
    wire: stream.wire,
    ready: deadline(ready, 5000, "TLS handshake"),
    request(text) {
      socket.write(text);
      return deadline(replies.length ? Promise.resolve(replies.shift()) : new Promise((r) => waiters.push(r)), 5000, `reply to ${text}`);
    },
  };
}

describe("endpoint TLS 1.3 through the opaque relay", () => {
  let relay;
  let dir;
  let real;
  let impostor;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "passio-relay-tls-"));
    real = makeCert(dir, "real");
    impostor = makeCert(dir, "impostor");
    relay = await startRelay();
  });
  after(async () => {
    await relay.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("pinned request/response succeeds and the relay only carries ciphertext", async () => {
    const host = await Host.register(relay);
    const sessions = serveTls(host, real);
    const client = await openTls(relay, host, real.cert);
    await client.ready;
    assert.equal(client.socket.getProtocol(), "TLSv1.3");
    assert.equal(await client.request("GET /secret-plaintext"), "reply:GET /secret-plaintext");
    const relayed = Buffer.concat([...client.wire.sent, ...client.wire.received]);
    assert.equal(relayed.includes("secret-plaintext"), false);
    assert.deepEqual(sessions[0].plaintext, ["GET /secret-plaintext"]);
    client.socket.destroy();
    await host.close();
  });

  test("a host presenting a different identity is rejected by the client", async () => {
    const host = await Host.register(relay);
    serveTls(host, impostor);
    const client = await openTls(relay, host, real.cert);
    await assert.rejects(client.ready, (err) => /self.signed|certificate|pinned/i.test(`${err.code} ${err.message}`));
    client.socket.destroy();
    await host.close();
  });

  test("modified ciphertext is rejected by the receiving endpoint", async () => {
    const host = await Host.register(relay);
    const sessions = serveTls(host, real);
    const client = await openTls(relay, host, real.cert);
    await client.ready;
    assert.equal(await client.request("first"), "reply:first");
    client.wire.mutate = (chunk) => {
      chunk[chunk.length - 1] ^= 0x01;
      return chunk;
    };
    client.socket.write("tampered");
    const err = await deadline(sessions[0].failed, 5000, "host TLS failure");
    assert.match(`${err.code} ${err.message}`, /DECRYPT|BAD_RECORD_MAC/i);
    assert.deepEqual(sessions[0].plaintext, ["first"]);
    client.socket.destroy();
    await host.close();
  });

  test("a replayed encrypted record is rejected by the receiving endpoint", async () => {
    const host = await Host.register(relay);
    const sessions = serveTls(host, real);
    const client = await openTls(relay, host, real.cert);
    await client.ready;
    assert.equal(await client.request("pay 10"), "reply:pay 10");
    const record = client.wire.sent.at(-1);
    assert.equal(record[0], 0x17);
    await client.conn.send(record, { binary: true });
    const err = await deadline(sessions[0].failed, 5000, "host TLS failure");
    assert.match(`${err.code} ${err.message}`, /DECRYPT|BAD_RECORD_MAC/i);
    assert.deepEqual(sessions[0].plaintext, ["pay 10"]);
    client.socket.destroy();
    await host.close();
  });

  test("a fresh connection after failures negotiates a new session", async () => {
    const host = await Host.register(relay);
    const sessions = serveTls(host, real);
    const broken = await openTls(relay, host, real.cert);
    await broken.ready;
    broken.wire.mutate = (chunk) => {
      chunk[chunk.length - 1] ^= 0x80;
      return chunk;
    };
    broken.socket.write("x");
    await deadline(sessions[0].failed, 5000, "first session failure");
    broken.socket.destroy();
    const fresh = await openTls(relay, host, real.cert);
    await fresh.ready;
    assert.equal(await fresh.request("hello again"), "reply:hello again");
    assert.equal(sessions[1].error, null);
    fresh.socket.destroy();
    await host.close();
  });
});
