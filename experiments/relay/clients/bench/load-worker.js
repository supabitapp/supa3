import { parentPort, workerData } from "node:worker_threads";
import WebSocket from "ws";

const { urls, payloadSize, inflight, workerIndex } = workerData;
const ECHO_TIMEOUT_MS = 5000;

function connectClient(url, index) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    const client = { ws, index, seq: 0, pending: new Map(), open: false };
    ws.binaryType = "nodebuffer";
    ws.once("open", () => ws.send(Buffer.from("probe"), { binary: true }));
    ws.once("message", () => {
      client.open = true;
      client.connectMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve(client);
    });
    ws.once("error", (err) => resolve({ ...client, error: err.message }));
    ws.once("unexpected-response", (_req, res) => resolve({ ...client, error: `HTTP ${res.statusCode}` }));
    setTimeout(() => resolve({ ...client, error: client.open ? undefined : "connect timeout" }), 10000).unref();
  });
}

const template = Buffer.alloc(payloadSize);
for (let i = 0; i < payloadSize; i++) template[i] = (i * 31 + 7) & 0xff;

function makePayload(client) {
  const buf = Buffer.from(template);
  if (payloadSize >= 8) {
    buf.writeUInt32BE(client.index, 0);
    buf.writeUInt32BE(client.seq, 4);
  }
  client.seq++;
  return buf;
}

const clients = await Promise.all(urls.map((url, i) => connectClient(url, workerIndex * 100000 + i)));
const failedConnects = clients.filter((c) => c.error).map((c) => c.error);
const live = clients.filter((c) => !c.error);
parentPort.postMessage({ type: "ready", connectMs: live.map((c) => c.connectMs), failedConnects });

const { startAt, warmupMs, measureMs } = await new Promise((resolve) => parentPort.once("message", resolve));
const windowStart = startAt + warmupMs;
const windowEnd = windowStart + measureMs;
const rtts = [];
let messages = 0;
let bytes = 0;
let corrupt = 0;
let timeouts = 0;
let running = true;

for (const client of live) {
  const sendOne = () => {
    if (!running || client.ws.readyState !== WebSocket.OPEN) return;
    const payload = makePayload(client);
    const sentAt = performance.now();
    client.pending.set(client.seq - 1, { payload, sentAt });
    client.order ??= [];
    client.order.push(client.seq - 1);
    client.ws.send(payload, { binary: true });
  };
  client.ws.on("message", (data) => {
    const now = performance.now();
    const seq = client.order.shift();
    const entry = client.pending.get(seq);
    client.pending.delete(seq);
    if (!entry || !Buffer.from(data).equals(entry.payload)) corrupt++;
    const at = Date.now();
    if (entry && at >= windowStart && at < windowEnd) {
      rtts.push(now - entry.sentAt);
      messages++;
      bytes += data.length;
    }
    sendOne();
  });
  client.start = () => {
    for (let i = 0; i < inflight; i++) sendOne();
  };
}

await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - Date.now())));
for (const client of live) client.start();
await new Promise((resolve) => setTimeout(resolve, windowEnd - Date.now()));
running = false;
const drainUntil = performance.now() + ECHO_TIMEOUT_MS;
while (live.some((c) => c.pending.size > 0) && performance.now() < drainUntil) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
for (const client of live) timeouts += client.pending.size;
for (const client of live) client.ws.close(1000);
parentPort.postMessage({ type: "done", rtts: Float64Array.from(rtts), messages, bytes, corrupt, timeouts });
