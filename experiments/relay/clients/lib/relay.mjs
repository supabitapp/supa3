import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deferred, withDeadline } from './util.mjs';

const relayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const testDefaults = {
  RELAY_ADDR: '127.0.0.1:0',
  RELAY_ADMISSION_RATE: '100000',
};

export async function startRelay(env = {}, { wrapper = [] } = {}) {
  const runScript = path.join(relayDir, 'run.sh');
  const child = spawn(wrapper[0] ?? runScript, [...wrapper.slice(1), ...(wrapper.length ? [runScript] : [])], {
    env: { ...process.env, ...testDefaults, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const listening = deferred();
  const exit = deferred();
  let stderr = '';
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.event === 'listening') listening.resolve(parsed.address);
      } catch {}
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', (code, signal) => { exit.resolve({ code, signal }); listening.reject(new Error(`relay exited early: ${stderr}`)); });
  child.on('error', (err) => { exit.reject(err); listening.reject(err); });

  const address = await withDeadline(listening.promise, 15000, 'relay listening');
  const base = `http://${address}`;

  const relay = {
    address,
    pid: child.pid,
    get stderr() { return stderr; },
    get stdout() { return stdout; },
    exited: exit.promise,
    async healthz() {
      const res = await fetch(`${base}/healthz`);
      return { status: res.status, body: await res.json() };
    },
    async metrics() {
      const res = await fetch(`${base}/metrics`);
      return res.json();
    },
    async waitMetrics(predicate, ms = 5000, label = 'metrics condition') {
      const deadline = Date.now() + ms;
      let last;
      while (Date.now() < deadline) {
        last = await relay.metrics();
        if (predicate(last)) return last;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`deadline ${ms}ms exceeded: ${label}; last metrics ${JSON.stringify(last)}`);
    },
    signal(sig) { child.kill(sig); },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      return exit.promise;
    },
  };
  return relay;
}
