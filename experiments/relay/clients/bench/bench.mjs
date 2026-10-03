import { fork, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startRelay } from '../lib/relay.mjs';
import { generateHostKey, urls } from '../lib/protocol.mjs';
import { connectHost, connectClient, pair } from '../lib/host.mjs';
import { send, trackClose, connectionStats, PortExhaustion } from '../lib/ws.mjs';
import { deferred, withDeadline } from '../lib/util.mjs';
import { runEchoCase, percentiles } from './driver.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const quick = process.env.BENCH_QUICK === '1';
const warmupMs = quick ? 500 : 2000;
const measureMs = quick ? 1500 : 5000;
const outDir = process.env.BENCH_OUT ?? path.join(os.tmpdir(), 'passio-relay-bench', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(outDir, { recursive: true });

const relayEnv = {
  RELAY_MAX_CLIENTS: '2048',
  RELAY_MAX_CLIENTS_PER_HOST: '256',
  RELAY_MAX_PENDING_PER_HOST: '1024',
  RELAY_ADMISSION_RATE: '100000',
  RELAY_MAX_QUEUE_BYTES: String(8 * 1024 * 1024),
};

function log(msg) { process.stderr.write(`[bench] ${msg}\n`); }

function sampleProcess(pid) {
  const out = execFileSync('ps', ['-o', 'rss=,cputime=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const [rss, cputime] = out.split(/\s+/);
  const parts = cputime.split(':').map(Number);
  const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  return { rssBytes: Number(rss) * 1024, cpuSeconds: seconds };
}

function forkChild(script, args) {
  const child = fork(path.join(here, script), args, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const ready = deferred();
  child.once('message', (msg) => { if (msg.type === 'ready') ready.resolve(msg); });
  child.once('exit', (code) => ready.reject(new Error(`${script} exited with ${code}`)));
  return { child, ready: withDeadline(ready.promise, 30_000, `${script} ready`), stop: () => { try { child.send('exit'); } catch {} child.kill('SIGKILL'); } };
}

async function withRelay(fn, env = {}) {
  const relay = await startRelay({ ...relayEnv, ...env });
  try { return await fn(relay); } finally { await relay.stop(); }
}

async function relayEchoCase({ clients, payloadBytes, hosts }) {
  return withRelay(async (relay) => {
    const echo = forkChild('echo-host.mjs', [relay.address, String(hosts)]);
    try {
      const { endpointIds } = await echo.ready;
      const before = sampleProcess(relay.pid);
      const metricsBefore = await relay.metrics();
      let peakRss = before.rssBytes;
      const sampler = setInterval(() => { try { peakRss = Math.max(peakRss, sampleProcess(relay.pid).rssBytes); } catch {} }, 500);
      const result = await runEchoCase({ urlFor: (i) => urls.connect(relay.address, endpointIds[i % endpointIds.length]), clients, payloadBytes, warmupMs, measureMs });
      clearInterval(sampler);
      const after = sampleProcess(relay.pid);
      const metricsAfter = await relay.metrics();
      const wallSeconds = (warmupMs + measureMs) / 1000 + (result.establishMs.count ? 0 : 0);
      return {
        ...result,
        target: 'relay',
        hosts,
        relay: {
          cpuSecondsDuringCase: after.cpuSeconds - before.cpuSeconds,
          cpuPercentApprox: ((after.cpuSeconds - before.cpuSeconds) / (result.measureSeconds + warmupMs / 1000)) * 100,
          rssBytesAfter: after.rssBytes,
          rssBytesPeak: peakRss,
          forwardedMessagesDelta: metricsAfter.forwardedMessages - metricsBefore.forwardedMessages,
          forwardedBytesDelta: metricsAfter.forwardedBytes - metricsBefore.forwardedBytes,
          wallSecondsApprox: wallSeconds,
        },
      };
    } finally { echo.stop(); }
  });
}

async function baselineEchoCase({ clients, payloadBytes }) {
  const server = forkChild('echo-server.mjs', []);
  try {
    const { port } = await server.ready;
    const result = await runEchoCase({ urlFor: () => `ws://127.0.0.1:${port}/`, clients, payloadBytes, warmupMs, measureMs });
    return { ...result, target: 'direct-websocket-baseline' };
  } finally { server.stop(); }
}

async function idleMemory() {
  return withRelay(async (relay) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const result = { steps: [] };
    await sleep(1000);
    result.steps.push({ pairedClients: 0, ...sampleProcess(relay.pid) });
    const hosts = [];
    for (let i = 0; i < 5; i++) hosts.push(await connectHost(relay.address, generateHostKey()));
    const pairs = [];
    const addPairs = async (count) => {
      for (let i = 0; i < count; i += 25) {
        const batch = [];
        for (let j = i; j < Math.min(count, i + 25); j++) batch.push(pair(relay, hosts[(pairs.length + j) % hosts.length]));
        pairs.push(...(await Promise.all(batch)));
      }
    };
    const t100 = performance.now();
    await addPairs(100);
    const connect100Ms = performance.now() - t100;
    await relay.waitMetrics((m) => m.activePairs === 100, 10_000, '100 pairs active');
    await sleep(2000);
    result.steps.push({ pairedClients: 100, connectMs: connect100Ms, ...sampleProcess(relay.pid) });
    const t500 = performance.now();
    await addPairs(400);
    const connect400Ms = performance.now() - t500;
    await relay.waitMetrics((m) => m.activePairs === 500, 20_000, '500 pairs active');
    await sleep(2000);
    result.steps.push({ pairedClients: 500, connectMs: connect400Ms, ...sampleProcess(relay.pid) });
    const closes = pairs.map(({ client, hostSocket }) => Promise.all([trackClose(client), trackClose(hostSocket)]));
    const tClose = performance.now();
    for (const { client } of pairs) client.close(1000);
    await Promise.all(closes);
    await relay.waitMetrics((m) => m.activePairs === 0 && m.pendingPairs === 0, 20_000, 'all pairs released');
    result.cleanupMs = performance.now() - tClose;
    await sleep(2000);
    result.steps.push({ pairedClients: 0, afterDisconnect: true, ...sampleProcess(relay.pid) });
    result.metricsAfter = await relay.metrics();
    for (const h of hosts) await h.close(1000);
    return result;
  });
}

async function reconnectChurn() {
  return withRelay(async (relay) => {
    const host = await connectHost(relay.address, generateHostKey());
    const accepting = (async () => {
      for (;;) {
        let incoming;
        try { incoming = await host.nextIncoming(60_000); } catch { return; }
        host.accept(incoming).then((s) => { s.on('message', (d, b) => s.send(d, { binary: b })); s.on('error', () => {}); }).catch(() => {});
      }
    })();
    const cycles = quick ? 100 : 400;
    const concurrency = 10;
    const before = sampleProcess(relay.pid);
    const cycleMs = [];
    let failures = 0;
    const start = performance.now();
    let next = 0;
    const worker = async () => {
      while (next < cycles) {
        next++;
        const t = performance.now();
        try {
          const client = await connectClient(relay.address, host.key.endpointId);
          await send(client, 'churn', false);
          await client.queue.next(10_000);
          const closed = trackClose(client);
          client.close(1000);
          await closed;
          cycleMs.push(performance.now() - t);
        } catch (err) {
          failures++;
          if (err instanceof PortExhaustion) { next = cycles; throw err; }
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    const seconds = (performance.now() - start) / 1000;
    await relay.waitMetrics((m) => m.activePairs === 0 && m.pendingPairs === 0, 20_000, 'churn released');
    await new Promise((r) => setTimeout(r, 1000));
    const after = sampleProcess(relay.pid);
    await host.close(1000);
    await accepting;
    return { cycles, concurrency, failures, seconds, cyclesPerSecond: cycles / seconds, cycleMs: percentiles(cycleMs), rssBefore: before.rssBytes, rssAfter: after.rssBytes, cpuSeconds: after.cpuSeconds - before.cpuSeconds, metricsAfter: await relay.metrics() };
  });
}

async function slowReaderIsolation() {
  return withRelay(async (relay) => {
    const host = await connectHost(relay.address, generateHostKey());
    const healthy = await pair(relay, host);
    const slow = await pair(relay, host);
    healthy.hostSocket.on('message', (d, b) => healthy.hostSocket.send(d, { binary: b }));
    healthy.hostSocket.on('error', () => {});
    healthy.client.queue = null;
    healthy.client.removeAllListeners('message');
    const payload = crypto.randomBytes(1024);
    const measure = async (ms) => {
      const samples = [];
      const end = performance.now() + ms;
      while (performance.now() < end) {
        const t = performance.now();
        const reply = deferred();
        healthy.client.once('message', () => reply.resolve());
        healthy.client.send(payload, { binary: true });
        await withDeadline(reply.promise, 10_000, 'healthy echo');
        samples.push(performance.now() - t);
      }
      return percentiles(samples);
    };
    const quiet = await measure(quick ? 1000 : 3000);
    slow.client._socket.pause();
    const slowClosed = trackClose(slow.hostSocket);
    const chunk = crypto.randomBytes(64 * 1024);
    const floodStart = performance.now();
    let floodSent = 0;
    const flood = (async () => {
      while (slow.hostSocket.readyState === 1) {
        await send(slow.hostSocket, chunk, true).catch(() => {});
        floodSent++;
      }
    })();
    const during = await measure(quick ? 1500 : 4000);
    const slowClose = await withDeadline(slowClosed, 15_000, 'slow pair closed');
    const slowClosedAfterMs = performance.now() - floodStart;
    await flood;
    slow.client._socket.resume();
    await trackClose(slow.client);
    const afterwards = await measure(quick ? 1000 : 2000);
    await host.close(1000);
    return { healthyRttMsQuiet: quiet, healthyRttMsDuringFlood: during, healthyRttMsAfter: afterwards, slowPair: { closeCode: slowClose.code, closeReason: slowClose.reason, closedAfterMs: slowClosedAfterMs, floodMessagesSent: floodSent, floodBytesSent: floodSent * chunk.length } };
  });
}

function environmentInfo() {
  const relayDir = path.resolve(here, '..', '..');
  const elixir = execFileSync('/opt/homebrew/bin/elixir', ['--version'], { encoding: 'utf8' }).trim().split('\n');
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'node_modules', 'ws', 'package.json'), 'utf8'));
  const lock = fs.readFileSync(path.join(relayDir, 'mix.lock'), 'utf8');
  const dep = (name) => (lock.match(new RegExp(`"${name}": \\{:hex, :${name}, "([^"]+)"`)) ?? [])[1];
  return {
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
    wsLibrary: pkg.version,
    erlang: elixir[0],
    elixir: elixir[elixir.length - 1],
    cowboy: dep('cowboy'),
    ranch: dep('ranch'),
    plugCowboy: dep('plug_cowboy'),
    buildMode: 'MIX_ENV=prod mix release (strip_beams, JIT enabled by default on this OTP)',
    relayEnv,
    loadAverageAtStart: os.loadavg(),
    sharedMachine: true,
  };
}

function summarize(result) {
  const { samples, ...rest } = result;
  return rest;
}

async function main() {
  log(`raw output directory: ${outDir}`);
  const report = { startedAt: new Date().toISOString(), quick, warmupMs, measureMs, environment: environmentInfo(), echo: [], baseline: [] };
  const payloads = [64, 1024, 65536];
  const clientCounts = [1, 32, 128];
  const hostsFor = (clients) => (clients >= 128 ? 4 : 1);
  let index = 0;
  const save = (name, result) => {
    fs.writeFileSync(path.join(outDir, `${String(index++).padStart(3, '0')}-${name}.json`), JSON.stringify(result));
  };
  const pauseMs = quick ? 500 : 3000;
  report.failedCases = [];
  const runCase = async (name, fn) => {
    const attemptsBefore = connectionStats.attempts;
    try {
      const result = await fn();
      await new Promise((r) => setTimeout(r, pauseMs));
      return { ...result, connectionAttempts: connectionStats.attempts - attemptsBefore };
    } catch (err) {
      const portExhaustion = err instanceof PortExhaustion;
      log(`case ${name} failed: ${err.message}${portExhaustion ? '; cooling down 60s for TIME_WAIT' : ''}`);
      report.failedCases.push({ name, error: err.message, portExhaustion });
      if (portExhaustion) await new Promise((r) => setTimeout(r, 60_000));
      return null;
    }
  };
  for (const payloadBytes of payloads) {
    for (const clients of clientCounts) {
      const reps = payloadBytes === 1024 && clients === 32 ? 3 : 1;
      for (let rep = 0; rep < reps; rep++) {
        const relayName = `relay-${payloadBytes}B-${clients}c-rep${rep + 1}`;
        log(`relay echo payload=${payloadBytes} clients=${clients} rep=${rep + 1}/${reps}`);
        const r = await runCase(relayName, () => relayEchoCase({ clients, payloadBytes, hosts: hostsFor(clients) }));
        if (r) { save(relayName, r); report.echo.push({ repetition: rep + 1, ...summarize(r) }); }
        const baselineName = `baseline-${payloadBytes}B-${clients}c-rep${rep + 1}`;
        log(`relay echo payload=${payloadBytes} clients=${clients} baseline rep=${rep + 1}/${reps}`);
        const b = await runCase(baselineName, () => baselineEchoCase({ clients, payloadBytes }));
        if (b) { save(baselineName, b); report.baseline.push({ repetition: rep + 1, ...summarize(b) }); }
      }
    }
  }
  log('idle memory 0/100/500 pairs and cleanup');
  report.idleMemory = await runCase('idle-memory', idleMemory);
  if (report.idleMemory) save('idle-memory', report.idleMemory);
  log('reconnect churn');
  report.reconnectChurn = await runCase('reconnect-churn', reconnectChurn);
  if (report.reconnectChurn) save('reconnect-churn', report.reconnectChurn);
  log('slow reader isolation');
  report.slowReaderIsolation = await runCase('slow-reader-isolation', slowReaderIsolation);
  if (report.slowReaderIsolation) save('slow-reader-isolation', report.slowReaderIsolation);
  report.connectionStats = { ...connectionStats };
  report.finishedAt = new Date().toISOString();
  report.loadAverageAtEnd = os.loadavg();
  report.rawOutputDir = outDir;
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
