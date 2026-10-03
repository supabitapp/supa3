import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import WebSocket from "ws";
import { Host, getJson, relayDir, startRelay, waitFor } from "../lib.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WARMUP_MS = Number(process.env.BENCH_WARMUP_MS ?? 2000);
const MEASURE_MS = Number(process.env.BENCH_MEASURE_MS ?? 5000);
const INFLIGHT = Number(process.env.BENCH_INFLIGHT ?? 1);
const CHURN_CYCLES = Math.min(Number(process.env.BENCH_CHURN_CYCLES ?? 1000), 2000);
const OUT = process.env.BENCH_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), "passio-relay-bench-"));
const PAYLOADS = [64, 1024, 65536];
const CLIENTS = [1, 32, 128];
const MAIN_REPEATS = 3;
const RELAY_ENV = {
  RELAY_MAX_CLIENTS: "2048",
  RELAY_MAX_CLIENTS_PER_HOST: "512",
  RELAY_MAX_PENDING_PER_HOST: "512",
  RELAY_ADMISSION_RATE: "100000",
};

fs.mkdirSync(OUT, { recursive: true });
const children = new Set();
process.on("exit", () => {
  for (const child of children) child.kill("SIGTERM");
});

class PortExhausted extends Error {}

function checkPorts(errors) {
  if (errors.some((e) => /EADDRNOTAVAIL/.test(String(e)))) throw new PortExhausted("local ephemeral ports exhausted");
}

function log(message) {
  process.stderr.write(`[bench] ${message}\n`);
}

function spawnNode(script, args) {
  const proc = spawn(process.execPath, [path.join(here, script), ...args], { stdio: ["ignore", "pipe", "inherit"] });
  children.add(proc);
  proc.on("exit", () => children.delete(proc));
  const line = new Promise((resolve, reject) => {
    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
    });
    proc.on("exit", (code) => reject(new Error(`${script} exited with ${code}`)));
  });
  return { proc, line };
}

async function stopChild(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  proc.kill("SIGTERM");
  await exited;
}

function processStats(pids) {
  let rssKiB = 0;
  let cpuSeconds = 0;
  for (const pid of pids) {
    let out;
    try {
      out = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)], { encoding: "utf8" }).trim();
    } catch {
      continue;
    }
    const [rss, time] = out.split(/\s+/);
    rssKiB += Number(rss);
    cpuSeconds += time.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
  }
  return { rssKiB, cpuSeconds };
}

function sampler(pids) {
  const start = processStats(pids);
  const startedAt = performance.now();
  const rss = [start.rssKiB];
  const timer = setInterval(() => rss.push(processStats(pids).rssKiB), 250);
  return () => {
    clearInterval(timer);
    const end = processStats(pids);
    const wallSeconds = (performance.now() - startedAt) / 1000;
    rss.push(end.rssKiB);
    return {
      cpuPercent: round((100 * (end.cpuSeconds - start.cpuSeconds)) / wallSeconds),
      rssMiBMax: round(Math.max(...rss) / 1024),
      rssMiBEnd: round(end.rssKiB / 1024),
    };
  };
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function percentiles(values) {
  if (!values.length) return { count: 0 };
  const sorted = Float64Array.from(values).sort();
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1]),
  };
}

function histogram(values) {
  const buckets = {};
  for (const v of values) {
    const bucket = 2 ** Math.ceil(Math.log2(Math.max(v, 0.001) * 1000));
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(buckets).map(([us, n]) => [`<=${us}us`, n]));
}

async function startEndpoints(target, clients) {
  const count = Math.min(4, Math.ceil(clients / 32));
  if (target === "direct") {
    const servers = Array.from({ length: count }, () => spawnNode("direct-echo.js", []));
    const ports = await Promise.all(servers.map((s) => s.line));
    return {
      urls: ports.map(({ port }) => `ws://127.0.0.1:${port}/`),
      measuredPids: servers.map((s) => s.proc.pid),
      endpointPids: servers.map((s) => s.proc.pid),
      async stop() {
        await Promise.all(servers.map((s) => stopChild(s.proc)));
      },
    };
  }
  const relay = await startRelay(RELAY_ENV);
  const hosts = Array.from({ length: count }, () => spawnNode("echo-host.js", [relay.ws, "1"]));
  const ids = (await Promise.all(hosts.map((h) => h.line))).flatMap((r) => r.endpointIds);
  return {
    relay,
    urls: ids.map((id) => `${relay.ws}/v1/connect?endpointId=${id}`),
    measuredPids: [relay.pid],
    endpointPids: hosts.map((h) => h.proc.pid),
    async stop() {
      await Promise.all(hosts.map((h) => stopChild(h.proc)));
      await relay.stop();
    },
  };
}

async function runLoad(endpoints, clients, payloadSize, measureMs = MEASURE_MS) {
  const urls = Array.from({ length: clients }, (_, i) => endpoints.urls[i % endpoints.urls.length]);
  const workerCount = Math.min(4, clients);
  const workers = Array.from({ length: workerCount }, (_, w) => {
    const worker = new Worker(path.join(here, "load-worker.js"), {
      workerData: { urls: urls.filter((_, i) => i % workerCount === w), payloadSize, inflight: INFLIGHT, workerIndex: w },
    });
    const messages = [];
    const waiters = [];
    worker.on("message", (m) => (waiters.length ? waiters.shift()(m) : messages.push(m)));
    worker.on("error", (err) => (waiters.length ? waiters.shift()({ type: "error", error: err.message }) : messages.push({ type: "error", error: err.message })));
    return { worker, next: () => (messages.length ? Promise.resolve(messages.shift()) : new Promise((r) => waiters.push(r))) };
  });
  const ready = await Promise.all(workers.map((w) => w.next()));
  const failedConnects = ready.flatMap((r) => r.failedConnects ?? [r.error]);
  checkPorts(failedConnects);
  const connectMs = ready.flatMap((r) => r.connectMs ?? []);
  const startAt = Date.now() + 200;
  for (const w of workers) w.worker.postMessage({ startAt, warmupMs: WARMUP_MS, measureMs });
  let stopSampling;
  let endpointSampling;
  const samplingStart = setTimeout(() => {
    stopSampling = sampler(endpoints.measuredPids);
    endpointSampling = sampler(endpoints.endpointPids);
  }, startAt + WARMUP_MS - Date.now());
  const done = await Promise.all(workers.map((w) => w.next()));
  clearTimeout(samplingStart);
  const resources = stopSampling?.();
  const endpointResources = endpointSampling?.();
  await Promise.all(workers.map((w) => w.worker.terminate()));
  const rtts = done.flatMap((d) => Array.from(d.rtts ?? []));
  const messages = done.reduce((a, d) => a + (d.messages ?? 0), 0);
  const bytes = done.reduce((a, d) => a + (d.bytes ?? 0), 0);
  const seconds = measureMs / 1000;
  return {
    clients,
    payloadBytes: payloadSize,
    inflightPerClient: INFLIGHT,
    warmupMs: WARMUP_MS,
    measureMs,
    connectedClients: connectMs.length,
    failedConnects: failedConnects.length,
    connectEstablishmentMs: percentiles(connectMs),
    rttMs: percentiles(rtts),
    messagesPerSecond: round(messages / seconds, 1),
    echoPayloadMiBPerSecond: round(bytes / 1048576 / seconds),
    corrupt: done.reduce((a, d) => a + (d.corrupt ?? 0), 0),
    timeouts: done.reduce((a, d) => a + (d.timeouts ?? 0), 0),
    workerErrors: done.filter((d) => d.type === "error").map((d) => d.error),
    measuredProcess: resources,
    echoEndpoints: endpointResources,
    histogram: histogram(rtts),
  };
}

async function matrix() {
  const runs = [];
  const cases = [];
  for (const payload of PAYLOADS) {
    for (const clients of CLIENTS) {
      const repeats = payload === 1024 && clients === 32 ? MAIN_REPEATS : 1;
      for (let rep = 1; rep <= repeats; rep++) {
        for (const target of ["relay", "direct"]) cases.push({ target, payload, clients, rep });
      }
    }
  }
  const only = process.env.BENCH_ONLY ? new Set(process.env.BENCH_ONLY.split(",")) : null;
  for (const c of cases) {
    const id = `${c.target}-${c.payload}B-${c.clients}c-r${c.rep}`;
    if (only && !only.has(id)) continue;
    log(`run ${id}`);
    const endpoints = await startEndpoints(c.target, c.clients);
    try {
      const result = { id, target: c.target, repetition: c.rep, ...(await runLoad(endpoints, c.clients, c.payload)) };
      fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(result, null, 2));
      const { histogram: _, ...summary } = result;
      runs.push(summary);
    } finally {
      await endpoints.stop();
    }
  }
  return runs;
}

function openPairedClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    ws.once("open", () => ws.send("probe"));
    ws.once("message", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

async function openMany(urls, concurrency = 25) {
  const sockets = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = await Promise.allSettled(urls.slice(i, i + concurrency).map(openPairedClient));
    const errors = batch.filter((r) => r.status === "rejected").map((r) => r.reason.message);
    checkPorts(errors);
    if (errors.length) throw new Error(`failed to open ${errors.length} clients: ${errors[0]}`);
    sockets.push(...batch.map((r) => r.value));
  }
  return sockets;
}

async function settledRss(pid) {
  await new Promise((r) => setTimeout(r, 2000));
  const samples = [];
  for (let i = 0; i < 5; i++) {
    samples.push(processStats([pid]).rssKiB);
    await new Promise((r) => setTimeout(r, 200));
  }
  samples.sort((a, b) => a - b);
  return round(samples[2] / 1024);
}

async function metrics(relay) {
  return (await getJson(`${relay.http}/metrics`)).body;
}

async function memoryAndChurn() {
  const relay = await startRelay(RELAY_ENV);
  const hosts = spawnNode("echo-host.js", [relay.ws, "5"]);
  const { endpointIds } = await hosts.line;
  const urlFor = (i) => `${relay.ws}/v1/connect?endpointId=${endpointIds[i % endpointIds.length]}`;
  const result = { hosts: endpointIds.length, idle: [] };
  try {
    const sockets = [];
    for (const target of [0, 100, 500]) {
      sockets.push(...(await openMany(Array.from({ length: target - sockets.length }, (_, i) => urlFor(sockets.length + i)))));
      await waitFor(async () => (await metrics(relay)).activePairs === target, `${target} active pairs`, 20000);
      result.idle.push({ pairedClients: target, relayRssMiB: await settledRss(relay.pid) });
      log(`idle ${target}`);
    }
    const closeStarted = performance.now();
    for (const ws of sockets) ws.close(1000);
    await waitFor(async () => {
      const m = await metrics(relay);
      return m.activePairs === 0 && m.pendingPairs === 0;
    }, "cleanup", 20000);
    result.cleanup = { releaseMs: round(performance.now() - closeStarted, 1), relayRssMiB: await settledRss(relay.pid), metrics: await metrics(relay) };

    const latencies = [];
    let failures = 0;
    let next = 0;
    const churnStarted = performance.now();
    const stop = sampler([relay.pid]);
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        while (next < CHURN_CYCLES) {
          const i = next++;
          const started = performance.now();
          try {
            const ws = await openPairedClient(urlFor(i));
            await new Promise((resolve) => {
              ws.once("close", resolve);
              ws.close(1000);
            });
            latencies.push(performance.now() - started);
          } catch (err) {
            checkPorts([err.message]);
            failures++;
          }
        }
      }),
    );
    const churnSeconds = (performance.now() - churnStarted) / 1000;
    const resources = stop();
    await waitFor(async () => {
      const m = await metrics(relay);
      return m.activePairs === 0 && m.pendingPairs === 0;
    }, "churn cleanup", 20000);
    result.churn = {
      cycles: CHURN_CYCLES,
      concurrency: 16,
      failures,
      cyclesPerSecond: round(CHURN_CYCLES / churnSeconds, 1),
      cycleMs: percentiles(latencies),
      relay: resources,
      relayRssMiBAfter: await settledRss(relay.pid),
      metricsAfter: await metrics(relay),
    };
    log("churn done");
  } finally {
    await stopChild(hosts.proc);
    await relay.stop();
  }
  return result;
}

async function slowReader() {
  const relay = await startRelay(RELAY_ENV);
  const echo = spawnNode("echo-host.js", [relay.ws, "1"]);
  const { endpointIds } = await echo.line;
  const endpoints = { urls: [`${relay.ws}/v1/connect?endpointId=${endpointIds[0]}`], measuredPids: [relay.pid], endpointPids: [echo.proc.pid] };
  try {
    const baseline = await runLoad(endpoints, 1, 1024);
    const flooder = await Host.register(relay);
    const stalled = await flooder.pair();
    stalled.client.ws._socket.pause();
    const payload = crypto.randomBytes(65536);
    const floodStarted = performance.now();
    let sent = 0;
    let closed = null;
    stalled.data.closed.then((c) => (closed = { ...c, afterMs: round(performance.now() - floodStarted, 1) }));
    const pump = () => {
      for (let n = 0; n < 16 && !closed && stalled.data.ws.readyState === 1 && stalled.data.ws.bufferedAmount < 4 * 1048576; n++) {
        stalled.data.ws.send(payload);
        sent++;
      }
      if (!closed && stalled.data.ws.readyState === 1) setTimeout(pump, 1);
    };
    pump();
    const underFlood = await runLoad(endpoints, 1, 1024);
    stalled.client.ws.terminate();
    await flooder.close();
    const { histogram: _a, ...base } = baseline;
    const { histogram: _b, ...flood } = underFlood;
    return {
      flood: { payloadBytes: 65536, messagesSent: sent, stalledPairClose: closed },
      healthyBaseline: base,
      healthyDuringFlood: flood,
    };
  } finally {
    await stopChild(echo.proc);
    await relay.stop();
  }
}

function environment() {
  const run = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  const lock = fs.readFileSync(path.join(relayDir, "mix.lock"), "utf8");
  const dep = (name) => lock.match(new RegExp(`"${name}": \\{:hex, :${name}, "([^"]+)"`))?.[1];
  return {
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    os: run("sw_vers", ["-productVersion"]),
    cpu: os.cpus()[0]?.model,
    cpus: os.cpus().length,
    memoryGiB: round(os.totalmem() / 2 ** 30, 1),
    node: process.version,
    ws: JSON.parse(fs.readFileSync(path.join(relayDir, "clients/node_modules/ws/package.json"), "utf8")).version,
    elixir: run("/opt/homebrew/bin/elixir", ["--short-version"]),
    erts: fs.readFileSync(path.join(relayDir, "_build/prod/rel/passio_relay/releases/start_erl.data"), "utf8").trim(),
    cowboy: dep("cowboy"),
    ranch: dep("ranch"),
    build: "MIX_ENV=prod mix release (BEAM JIT), compression disabled, active_n 16",
    relayEnv: RELAY_ENV,
    sharedMachine: true,
  };
}

const started = new Date().toISOString();
const result = { started, rawDir: OUT, environment: environment(), workload: { warmupMs: WARMUP_MS, measureMs: MEASURE_MS, inflightPerClient: INFLIGHT, payloads: PAYLOADS, clients: CLIENTS, mainCaseRepetitions: MAIN_REPEATS } };
try {
  const sections = (process.env.BENCH_SECTIONS ?? "matrix,memory,slow").split(",");
  if (sections.includes("matrix")) result.runs = await matrix();
  if (sections.includes("memory")) result.memory = await memoryAndChurn();
  if (sections.includes("slow")) result.slowReader = await slowReader();
} catch (err) {
  result.aborted = { reason: err.message, portExhausted: err instanceof PortExhausted };
  log(`aborted: ${err.message}`);
}
result.finished = new Date().toISOString();
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.aborted ? 1 : 0);
