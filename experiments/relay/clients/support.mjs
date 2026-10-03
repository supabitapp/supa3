import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

export function deadline(promise, ms = 7000, label = 'operation') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  })]).finally(() => clearTimeout(timer));
}

export class Inbox {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.waiters = [];
    this.closed = new Promise(resolve => {
      ws.on('close', (code, reason) => {
        this.closeResult = { code, reason: reason.toString() };
        resolve(this.closeResult);
        for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(`socket closed: ${code}`));
      });
    });
    ws.on('error', () => {});
    ws.on('message', (data, binary) => {
      const message = { data, binary };
      const index = this.waiters.findIndex(waiter => waiter.predicate(message));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message);
      else this.messages.push(message);
    });
  }

  next(predicate = () => true, ms = 7000) {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    if (this.closeResult) return Promise.reject(new Error(`socket already closed: ${this.closeResult.code}`));
    let waiter;
    const promise = new Promise((resolve, reject) => {
      waiter = { predicate, resolve, reject };
      this.waiters.push(waiter);
    });
    return deadline(promise, ms, 'message').finally(() => {
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
    });
  }

  async json(type) {
    const message = await this.next(message => {
      if (message.binary) return false;
      try { return JSON.parse(message.data).type === type; } catch { return false; }
    });
    return JSON.parse(message.data);
  }
}

export async function socket(url, options = {}) {
  const ws = new WebSocket(url, { perMessageDeflate: false, ...options });
  const inbox = new Inbox(ws);
  await deadline(once(ws, 'open'), 7000, 'websocket upgrade');
  return Object.assign(ws, { inbox });
}

export async function rejected(url, expected) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  ws.on('error', () => {});
  const status = await deadline(new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_, response) => {
      const status = response.statusCode;
      response.resume();
      ws.terminate();
      resolve(status);
    });
    ws.once('open', () => { ws.terminate(); reject(new Error('unexpected upgrade')); });
    ws.once('error', error => { if (!error.message.includes('before the connection')) reject(error); });
  }));
  assert.ok([].concat(expected).includes(status), `unexpected HTTP status ${status}`);
  return status;
}

export function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, publicKey: raw.toString('base64url'), endpointId: createHash('sha256').update(raw).digest('hex') };
}

export function signature(keys, nonce) {
  return sign(null, Buffer.from(`passio-relay-v1\n${keys.endpointId}\n${nonce}`), keys.privateKey).toString('base64url');
}

export async function host(relay, keys = identity(), options = {}) {
  const ws = await socket(`${relay.ws}/v1/control?publicKey=${keys.publicKey}`, options);
  const challenge = await ws.inbox.json('challenge');
  assert.equal(Buffer.from(challenge.nonce, 'base64url').length, 32);
  ws.send(JSON.stringify({ type: 'authenticate', signature: signature(keys, challenge.nonce) }));
  const registration = await ws.inbox.json('registered');
  assert.equal(registration.endpointId, keys.endpointId);
  return { ws, keys, endpointId: keys.endpointId };
}

export async function pending(relay, h, options = {}) {
  const client = await socket(`${relay.ws}/v1/connect?endpointId=${h.endpointId}`, options);
  const incoming = await h.ws.inbox.json('incoming');
  assert.equal(Buffer.from(incoming.connectionId, 'base64url').length, 16);
  assert.equal(Buffer.from(incoming.token, 'base64url').length, 32);
  return { client, incoming };
}

export function acceptUrl(relay, h, incoming) {
  return `${relay.ws}/v1/accept?endpointId=${h.endpointId}&connectionId=${incoming.connectionId}&token=${incoming.token}`;
}

export async function pair(relay, h, options = {}) {
  const p = await pending(relay, h, options);
  p.accepted = await socket(acceptUrl(relay, h, p.incoming));
  return p;
}

export async function send(ws, data, binary = Buffer.isBuffer(data)) {
  return deadline(new Promise((resolve, reject) => ws.send(data, { binary }, error => error ? reject(error) : resolve())));
}

export async function echo(p, data = Buffer.from('probe')) {
  const next = p.client.inbox.next();
  await send(p.client, data);
  const received = await next;
  assert.deepEqual(received.data, Buffer.from(data));
  assert.equal(received.binary, Buffer.isBuffer(data));
}

export function echoHost(p) {
  p.accepted.on('message', (data, binary) => {
    p.accepted.inbox.messages.length = 0;
    if (p.accepted.readyState === WebSocket.OPEN) p.accepted.send(data, { binary });
  });
}

export async function closePair(p, h, code = 1000, reason = '') {
  const event = h.ws.inbox.json('closed');
  p.client.close(code, reason);
  const [client, accepted, closed] = await deadline(Promise.all([
    p.client.inbox.closed, p.accepted.inbox.closed, event
  ]));
  assert.equal(closed.connectionId, p.incoming.connectionId);
  return { client, accepted };
}

export async function startRelay(env = {}) {
  const child = spawn('bash', [fileURLToPath(new URL('../run.sh', import.meta.url))], {
    env: { ...process.env, RELAY_ADDR: '127.0.0.1:0', RELAY_ADMISSION_RATE: '10000', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const events = new EventEmitter();
  const stdout = [];
  const stderr = [];
  let exitResult;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    exitResult = { code, signal };
    resolve(exitResult);
    events.emit('exit', exitResult);
  }));
  child.on('error', error => events.emit('failed', error));
  createInterface({ input: child.stdout }).on('line', line => {
    stdout.push(line);
    try { const value = JSON.parse(line); events.emit(value.event, value); } catch {}
  });
  createInterface({ input: child.stderr }).on('line', line => {
    stderr.push(line);
    try { const value = JSON.parse(line); events.emit(value.event, value); } catch {}
  });
  try {
    const listening = await deadline(new Promise((resolve, reject) => {
      events.once('listening', resolve);
      events.once('exit', () => reject(new Error(`relay startup failed: ${stderr.join('\n')}`)));
      events.once('failed', reject);
    }), 15000, 'relay startup');
    return {
      child, events, stdout, stderr, exited,
      ws: `ws://${listening.address}`, http: `http://${listening.address}`,
      metrics: async () => (await fetch(`http://${listening.address}/metrics`)).json(),
      async stop() {
        if (exitResult) return exitResult;
        child.kill('SIGTERM');
        try { return await deadline(exited, 7000, 'relay shutdown'); }
        finally { if (!exitResult) child.kill('SIGKILL'); }
      }
    };
  } catch (error) {
    child.kill('SIGKILL');
    await exited;
    throw error;
  }
}
