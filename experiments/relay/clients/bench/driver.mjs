import crypto from 'node:crypto';
import { openWs } from '../lib/ws.mjs';
import { deferred, withDeadline } from '../lib/util.mjs';

export function percentiles(samples) {
  if (samples.length === 0) return { count: 0 };
  const sorted = Float64Array.from(samples).sort();
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1], mean: sum / sorted.length };
}

function makePayload(bytes) {
  const buf = crypto.randomBytes(Math.max(bytes, 4));
  return buf.subarray(0, bytes);
}

export async function runEchoCase({ urlFor, clients, payloadBytes, warmupMs, measureMs, inflight = 1, connectConcurrency = 32, messageTimeoutMs = 10_000 }) {
  const payloadTemplate = makePayload(payloadBytes);
  const sockets = [];
  const establishMs = [];
  const failures = { mismatches: 0, timeouts: 0, closes: 0, errors: 0 };
  const samples = [];
  let phase = 'connect';
  let measuredBytes = 0;

  async function connectOne(i) {
    const start = performance.now();
    const ws = await openWs(urlFor(i), { timeoutMs: 15_000 });
    const probe = deferred();
    ws.once('message', () => probe.resolve());
    ws.send(Buffer.from([0, 0, 0, 0]), { binary: true });
    await probe.promise;
    establishMs.push(performance.now() - start);
    ws.queue = null;
    ws.removeAllListeners('message');
    return ws;
  }

  for (let i = 0; i < clients; i += connectConcurrency) {
    const batch = [];
    for (let j = i; j < Math.min(clients, i + connectConcurrency); j++) batch.push(withDeadline(connectOne(j), 30_000, `establish client ${j}`));
    sockets.push(...(await Promise.all(batch)));
  }

  const done = deferred();
  let active = sockets.length;

  function runClient(ws, index) {
    const payload = Buffer.from(payloadTemplate);
    let seq = 0;
    let outstanding = 0;
    const sentAt = new Map();
    let timer = null;

    const finish = () => {
      if (timer) clearTimeout(timer);
      if (--active === 0) done.resolve();
    };

    const sendOne = () => {
      if (phase === 'done') return;
      seq++;
      if (payload.length >= 4) payload.writeUInt32BE(seq >>> 0, 0);
      const t = performance.now();
      sentAt.set(seq, t);
      outstanding++;
      ws.send(payload, { binary: true });
      if (!timer) timer = setTimeout(() => { failures.timeouts++; phase === 'done' || ws.terminate(); }, messageTimeoutMs);
    };

    ws.on('message', (data) => {
      const now = performance.now();
      const buf = Buffer.from(data);
      const seqGot = buf.length >= 4 ? buf.readUInt32BE(0) : seq;
      const t = sentAt.get(seqGot);
      sentAt.delete(seqGot);
      outstanding--;
      if (timer && sentAt.size === 0) { clearTimeout(timer); timer = null; }
      if (t === undefined || buf.length !== payload.length || (buf.length >= 4 && !buf.subarray(4).equals(payload.subarray(4)))) failures.mismatches++;
      else if (phase === 'measure') { samples.push(now - t); measuredBytes += buf.length; }
      if (phase === 'done') { if (outstanding === 0) { ws.close(1000); } return; }
      sendOne();
    });
    ws.on('close', () => { if (phase !== 'done') failures.closes++; finish(); });
    ws.on('error', () => { failures.errors++; });
    for (let k = 0; k < inflight; k++) sendOne();
    void index;
  }

  phase = 'warmup';
  sockets.forEach(runClient);
  await new Promise((r) => setTimeout(r, warmupMs));
  phase = 'measure';
  const measureStart = performance.now();
  await new Promise((r) => setTimeout(r, measureMs));
  const measureSeconds = (performance.now() - measureStart) / 1000;
  phase = 'done';
  await Promise.race([done.promise, new Promise((r) => setTimeout(r, 10_000))]);
  for (const ws of sockets) if (ws.readyState !== 3) ws.terminate();

  return {
    clients,
    payloadBytes,
    inflightPerClient: inflight,
    warmupMs,
    measureSeconds,
    rtt: percentiles(samples),
    messagesPerSecond: samples.length / measureSeconds,
    payloadMiBPerSecond: measuredBytes / measureSeconds / (1024 * 1024),
    establishMs: percentiles(establishMs),
    failures,
    samples,
  };
}
