import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { closePair, deadline, echoHost, host, pair, send, socket, startRelay } from './support.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp('/tmp/passio-relay-elixir-bench-');
const warmupMs = 500;
const measurementMs = 1500;
const report = { artifactDirectory: directory, metadata: {}, cases: [], idle: [], churn: null, slowReader: null };
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { samples: values.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99) };
}

function cpuSeconds(value) {
  const parts = value.split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

async function resources(pid) {
  const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'rss=', '-o', 'time=']);
  const [rss, cpu] = stdout.trim().split(/\s+/);
  return { at: performance.now(), rssBytes: Number(rss) * 1024, cpuSeconds: cpuSeconds(cpu) };
}

async function observe(pid, operation) {
  const samples = [await resources(pid)];
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(async () => samples.push(await resources(pid)));
  }, 200);
  try {
    const result = await operation();
    clearInterval(timer);
    await pending;
    samples.push(await resources(pid));
    const first = samples[0];
    const last = samples.at(-1);
    return { result, samples, resources: {
      cpuPercentOneCore: (last.cpuSeconds - first.cpuSeconds) * 100000 / (last.at - first.at),
      cpuSeconds: last.cpuSeconds - first.cpuSeconds,
      rssStartBytes: first.rssBytes, rssEndBytes: last.rssBytes,
      rssPeakBytes: Math.max(...samples.map(sample => sample.rssBytes))
    } };
  } finally { clearInterval(timer); }
}

async function baseline() {
  const child = spawn(process.execPath, [join(root, 'clients/baseline.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', () => {});
  try {
    const [line] = await deadline(once(lines, 'line'));
    const { address } = JSON.parse(line);
    return { child, ws: `ws://${address}`, async stop() {
      child.kill('SIGTERM');
      try { await deadline(exited, 3000); } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
    } };
  } catch (error) { child.kill('SIGKILL'); await exited; throw error; }
}

async function setup(target, mode, count) {
  const hosts = [];
  const pairs = [];
  const sockets = [];
  const establishmentMs = [];
  try {
    for (let i = 0; i < count; i++) {
      if (mode === 'relay' && i % 125 === 0) hosts.push(await host(target));
      const started = performance.now();
      if (mode === 'relay') {
        const h = hosts.at(-1);
        const p = await pair(target, h);
        echoHost(p);
        pairs.push({ p, h });
        sockets.push(p.client);
      } else sockets.push(await socket(target.ws));
      establishmentMs.push(performance.now() - started);
    }
    return { sockets, pairs, hosts, establishmentMs, async close() {
      if (mode === 'relay') {
        for (const { p, h } of pairs) await closePair(p, h);
        for (const h of hosts) { h.ws.close(); await deadline(h.ws.inbox.closed); }
      } else {
        for (const ws of sockets) ws.close();
        await deadline(Promise.all(sockets.map(ws => ws.inbox.closed)));
      }
    } };
  } catch (error) {
    for (const ws of sockets) ws.terminate();
    for (const { p } of pairs) p.accepted.terminate();
    for (const h of hosts) h.ws.terminate();
    throw error;
  }
}

async function workload(sockets, payloadBytes, durationMs) {
  const samples = [];
  const started = performance.now();
  const until = started + durationMs;
  let failures = 0;
  let corruption = 0;
  let timeouts = 0;
  let completed = 0;
  const workers = sockets.map((ws, index) => new Promise(resolve => {
    const payload = Buffer.alloc(payloadBytes, index % 251);
    let sequence = 0;
    let sentAt;
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      ws.off('message', receive);
      ws.off('error', error);
      ws.off('close', disconnected);
      clearTimeout(timer);
      resolve();
    }
    function error() { failures++; finish(); }
    function disconnected() { if (!finished) error(); }
    function transmit() {
      payload.writeUInt32BE(index, 0);
      payload.writeUInt32BE(sequence++, 4);
      sentAt = performance.now();
      ws.send(payload, { binary: true }, err => { if (err && !finished) error(); });
    }
    function receive(data, binary) {
      ws.inbox.messages.length = 0;
      if (!binary || !data.equals(payload)) { corruption++; finish(); return; }
      const at = performance.now();
      samples.push(at - sentAt);
      completed++;
      if (at >= until) finish();
      else transmit();
    }
    const timer = setTimeout(() => { timeouts++; finish(); }, durationMs + 5000);
    ws.on('message', receive);
    ws.on('error', error);
    ws.on('close', disconnected);
    transmit();
  }));
  await Promise.all(workers);
  const elapsedMs = performance.now() - started;
  return { samples, durationMs: elapsedMs, completed, failures, corruption, timeouts,
    rtt: summary(samples), echoRequestsPerSecond: completed * 1000 / elapsedMs,
    forwardedMessagesPerSecond: completed * 2 * 1000 / elapsedMs,
    payloadMiBPerSecond: completed * payloadBytes * 2 * 1000 / elapsedMs / 1048576 };
}

async function runCase(target, mode, payloadBytes, clients, repetition) {
  const id = `${mode}-${payloadBytes}-${clients}-${repetition}`;
  const group = await setup(target, mode, clients);
  try {
    const warmup = await workload(group.sockets, payloadBytes, warmupMs);
    assert.equal(warmup.failures + warmup.corruption + warmup.timeouts, 0);
    const measured = await observe(target.child.pid, () => workload(group.sockets, payloadBytes, measurementMs));
    const { samples, ...result } = measured.result;
    const record = { id, mode, payloadBytes, clients, repetition, inFlightPerClient: 1,
      warmupMs, measurementTargetMs: measurementMs, ...result,
      establishment: summary(group.establishmentMs), resources: measured.resources };
    await writeFile(join(directory, `${id}.json`), JSON.stringify({ ...record, rttSamplesMs: samples,
      establishmentSamplesMs: group.establishmentMs, resourceSamples: measured.samples }));
    report.cases.push(record);
    emit({ event: 'case', ...record });
    assert.equal(result.failures + result.corruption + result.timeouts, 0);
  } finally { await group.close(); }
}

async function idle(relay) {
  for (const count of [0, 100, 500]) {
    const group = await setup(relay, 'relay', count);
    const metrics = await relay.metrics();
    assert.equal(metrics.activePairs, count);
    const observed = await observe(relay.child.pid, () => new Promise(resolve => setTimeout(resolve, 1000)));
    await group.close();
    const cleaned = await relay.metrics();
    assert.equal(cleaned.activePairs + cleaned.pendingPairs, 0);
    const cleanup = await observe(relay.child.pid, () => new Promise(resolve => setTimeout(resolve, 1000)));
    const record = { clients: count, hosts: group.hosts.length, observationMs: 1000,
      idle: observed.resources, cleanup: cleanup.resources, pairsAfterCleanup: cleaned.activePairs + cleaned.pendingPairs };
    report.idle.push(record);
    await writeFile(join(directory, `idle-${count}.json`), JSON.stringify({ ...record,
      idleSamples: observed.samples, cleanupSamples: cleanup.samples }));
    emit({ event: 'idle', ...record });
  }
}

async function churn(relay) {
  const establishment = [];
  const started = performance.now();
  const measured = await observe(relay.child.pid, async () => {
    for (let i = 0; i < 3; i++) {
      const group = await setup(relay, 'relay', 64);
      establishment.push(...group.establishmentMs);
      await group.close();
    }
  });
  const elapsedMs = performance.now() - started;
  const metrics = await relay.metrics();
  assert.equal(metrics.activePairs + metrics.pendingPairs, 0);
  report.churn = { connections: 192, rounds: 3, clientsPerRound: 64, durationMs: elapsedMs,
    connectionsPerSecond: 192000 / elapsedMs, establishment: summary(establishment),
    resources: measured.resources, pairsAfterCleanup: 0, failures: 0 };
  await writeFile(join(directory, 'churn.json'), JSON.stringify({ ...report.churn,
    establishmentSamplesMs: establishment, resourceSamples: measured.samples }));
  emit({ event: 'churn', ...report.churn });
}

async function slowReader() {
  const relay = await startRelay({ RELAY_MAX_QUEUE_BYTES: '262144', RELAY_MAX_QUEUE_MESSAGES: '8',
    RELAY_WRITE_TIMEOUT_MS: '250', RELAY_HEARTBEAT_MS: '15000' });
  const h = await host(relay);
  const slow = await pair(relay, h);
  const healthy = await setup(relay, 'relay', 1);
  slow.accepted._socket.pause();
  let offeredBytes = 0;
  let timer;
  try {
    const released = h.ws.inbox.json('closed');
    const began = performance.now();
    timer = setInterval(() => {
      if (slow.client.readyState === 1 && slow.client.bufferedAmount < 131072 && offeredBytes < 8388608) {
        slow.client.send(Buffer.alloc(65536), { binary: true }, () => {});
        offeredBytes += 65536;
      }
    }, 2);
    const measured = await observe(relay.child.pid, () => workload(healthy.sockets, 1024, 2000));
    const event = await deadline(released);
    assert.equal(event.connectionId, slow.incoming.connectionId);
    clearInterval(timer);
    const ending = await deadline(slow.client.inbox.closed);
    const { samples, ...healthyResult } = measured.result;
    assert.equal(healthyResult.failures + healthyResult.corruption + healthyResult.timeouts, 0);
    report.slowReader = { durationMs: performance.now() - began, offeredBytes, closeCode: ending.code,
      closeReason: ending.reason, healthy: healthyResult, resources: measured.resources };
    await writeFile(join(directory, 'slow-reader.json'), JSON.stringify({ ...report.slowReader,
      rttSamplesMs: samples, resourceSamples: measured.samples }));
    emit({ event: 'slowReader', ...report.slowReader });
  } finally {
    clearInterval(timer);
    slow.accepted._socket.resume();
    slow.accepted.terminate();
    slow.client.terminate();
    await healthy.close();
    h.ws.close();
    await relay.stop();
  }
}

let relay;
let direct;
try {
  relay = await startRelay({ RELAY_MAX_CLIENTS: '1200', RELAY_MAX_CLIENTS_PER_HOST: '128',
    RELAY_MAX_PENDING_PER_HOST: '128', RELAY_ADMISSION_RATE: '10000', RELAY_WRITE_TIMEOUT_MS: '1000' });
  direct = await baseline();
  const digest = createHash('sha256');
  const sourceFiles = (await readdir(join(root, 'lib/passio_relay'))).sort();
  for (const file of sourceFiles) digest.update(await readFile(join(root, 'lib/passio_relay', file)));
  digest.update(await readFile(join(root, 'mix.lock')));
  const { stdout: runtime } = await exec('/opt/homebrew/bin/elixir', ['--version'], { env: { ...process.env, ERL_FLAGS: '+S 4:4' } });
  const { stdout: fdLimit } = await exec('/bin/bash', ['-c', 'ulimit -n']);
  report.metadata = { platform: os.platform(), release: os.release(), architecture: os.arch(),
    cpu: os.cpus()[0].model, logicalCPUs: os.cpus().length, totalMemoryBytes: os.totalmem(),
    node: process.version, openssl: process.versions.openssl, runtime: runtime.trim(),
    ws: JSON.parse(await readFile(join(root, 'node_modules/ws/package.json'))).version,
    mixLock: await readFile(join(root, 'mix.lock'), 'utf8'), sourceSha256: digest.digest('hex'),
    build: 'MIX_ENV=prod mix release; stripped BEAMs; distribution disabled',
    flags: process.env.ERL_FLAGS || '+S 4:4', fileDescriptorLimit: Number(fdLimit.trim()),
    loopback: true, compression: false, inFlightPerClient: 1, warmupMs, measurementMs,
    setup: 'sequential client admission; registered hosts excluded from establishment latency',
    limits: { maxClients: 1200, maxClientsPerHost: 128, maxPendingPerHost: 128, admissionRate: 10000, writeTimeoutMs: 1000 },
    payloadAccounting: 'request plus response application bytes; excludes framing',
    cpuAccounting: 'ps cumulative process CPU delta / observed wall time, 100% equals one core',
    limitations: 'shared machine; loopback; short runs; one driver and host endpoint process; no capacity extrapolation',
    timestamp: new Date().toISOString() };
  emit({ event: 'metadata', ...report.metadata, artifactDirectory: directory });
  for (const payloadBytes of [64, 1024, 65536]) for (const clients of [1, 32, 128]) {
    await runCase(direct, 'direct', payloadBytes, clients, 1);
    await runCase(relay, 'relay', payloadBytes, clients, 1);
  }
  for (const repetition of [2, 3]) {
    await runCase(direct, 'direct', 1024, 32, repetition);
    await runCase(relay, 'relay', 1024, 32, repetition);
  }
  await idle(relay);
  await churn(relay);
  await slowReader();
  report.finalMetrics = await relay.metrics();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  if (direct) await direct.stop();
  if (relay) await relay.stop();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  emit({ event: 'complete', status: report.status, report: join(directory, 'report.json'), error: report.error });
}
