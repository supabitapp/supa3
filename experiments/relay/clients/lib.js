import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
export const relayDir = path.resolve(here, "..");

export function deadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function startRelay(env = {}) {
  const proc = spawn("bash", [path.join(relayDir, "run.sh")], {
    env: { ...process.env, RELAY_ADDR: "127.0.0.1:0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
  const address = await deadline(
    new Promise((resolve, reject) => {
      let buffer = "";
      proc.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (const line of buffer.split("\n")) {
          try {
            const event = JSON.parse(line);
            if (event.event === "listening") resolve(event.address);
          } catch {}
        }
      });
      proc.on("exit", () => reject(new Error(`relay exited before listening: ${stderr}`)));
    }),
    20000,
    "relay listening",
  );
  const relay = {
    pid: proc.pid,
    address,
    exited,
    stderr: () => stderr,
    http: `http://${address}`,
    ws: `ws://${address}`,
    async stop() {
      terminateAll();
      if (proc.exitCode !== null || proc.signalCode !== null) return exited;
      proc.kill("SIGTERM");
      try {
        return await deadline(exited, 10000, "relay exit");
      } catch {
        proc.kill("SIGKILL");
        return exited;
      }
    },
  };
  return relay;
}

export async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

export async function waitFor(check, label, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function metricsWhere(relay, predicate, label) {
  return waitFor(async () => {
    const { body } = await getJson(`${relay.http}/metrics`);
    return predicate(body) ? body : null;
  }, label);
}

const sockets = new Set();

export function terminateAll() {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
}

export class Conn {
  constructor(ws) {
    this.ws = ws;
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    this.queue = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws.on("message", (data, isBinary) => {
      const message = { data: Buffer.from(data), isBinary };
      if (this.sink) return this.sink(message);
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
    ws.on("error", () => {});
  }

  pipe(sink) {
    this.sink = sink;
    for (const message of this.queue.splice(0)) sink(message);
  }

  next(ms = 3000, label = "message") {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    const message = new Promise((resolve) => this.waiters.push(resolve));
    return deadline(Promise.race([message, this.closed.then((c) => Promise.reject(new Error(`closed ${c.code} ${c.reason} while waiting for ${label}`)))]), ms, label);
  }

  async json(ms, label) {
    const message = await this.next(ms, label);
    return JSON.parse(message.data.toString());
  }

  send(data, options) {
    return new Promise((resolve, reject) => this.ws.send(data, options ?? {}, (err) => (err ? reject(err) : resolve())));
  }

  close(code, reason) {
    this.ws.close(code, reason);
    return this.closed;
  }

  waitClose(ms = 3000, label = "close") {
    return deadline(this.closed, ms, label);
  }
}

export function connect(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024, ...options });
    const conn = new Conn(ws);
    ws.once("open", () => resolve(conn));
    ws.once("unexpected-response", (_req, res) => {
      const err = new Error(`HTTP ${res.statusCode}`);
      err.status = res.statusCode;
      res.resume();
      ws.terminate();
      reject(err);
    });
    ws.once("error", reject);
  });
}

export async function connectStatus(url) {
  try {
    const conn = await connect(url);
    conn.ws.terminate();
    return 101;
  } catch (err) {
    return err.status ?? err.message;
  }
}

export function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyB64 = publicKey.export({ format: "jwk" }).x;
  const raw = Buffer.from(publicKeyB64, "base64url");
  const endpointId = crypto.createHash("sha256").update(raw).digest("hex");
  return { publicKey, privateKey, publicKeyB64, endpointId };
}

export function sign(keys, endpointId, nonce) {
  return crypto.sign(null, Buffer.from(`passio-relay-v1\n${endpointId}\n${nonce}`), keys.privateKey).toString("base64url");
}

export class Host {
  constructor(relay, keys, control) {
    this.relay = relay;
    this.keys = keys;
    this.endpointId = keys.endpointId;
    this.control = control;
    this.events = [];
    this.eventWaiters = [];
    this.closedCounts = new Map();
  }

  static async open(relay, keys = keyPair()) {
    const control = await connect(`${relay.ws}/v1/control?publicKey=${keys.publicKeyB64}`);
    const challenge = await control.json(3000, "challenge");
    return { control, challenge, keys };
  }

  static async register(relay, keys = keyPair()) {
    const { control, challenge } = await Host.open(relay, keys);
    await control.send(JSON.stringify({ type: "authenticate", signature: sign(keys, keys.endpointId, challenge.nonce) }));
    const registered = await control.json(3000, "registered");
    if (registered.type !== "registered" || registered.endpointId !== keys.endpointId) {
      throw new Error(`unexpected registration reply ${JSON.stringify(registered)}`);
    }
    const host = new Host(relay, keys, control);
    host.pump();
    return host;
  }

  async pump() {
    for (;;) {
      let event;
      try {
        event = await this.control.json(1e9, "control event");
      } catch {
        return;
      }
      if (event.type === "closed") this.closedCounts.set(event.connectionId, (this.closedCounts.get(event.connectionId) ?? 0) + 1);
      const index = this.eventWaiters.findIndex((w) => w.match(event));
      if (index >= 0) this.eventWaiters.splice(index, 1)[0].resolve(event);
      else this.events.push(event);
    }
  }

  nextEvent(match, ms = 3000, label = "control event") {
    const index = this.events.findIndex(match);
    if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]);
    return deadline(new Promise((resolve) => this.eventWaiters.push({ match, resolve })), ms, label);
  }

  incoming(ms) {
    return this.nextEvent((e) => e.type === "incoming", ms, "incoming");
  }

  closedEvent(connectionId, ms) {
    return this.nextEvent((e) => e.type === "closed" && e.connectionId === connectionId, ms, `closed ${connectionId}`);
  }

  acceptUrl(incoming, overrides = {}) {
    const params = new URLSearchParams({
      endpointId: this.endpointId,
      connectionId: incoming.connectionId,
      token: incoming.token,
      ...overrides,
    });
    return `${this.relay.ws}/v1/accept?${params}`;
  }

  accept(incoming, overrides) {
    return connect(this.acceptUrl(incoming, overrides));
  }

  async pair(clientOptions) {
    const client = await connect(`${this.relay.ws}/v1/connect?endpointId=${this.endpointId}`, clientOptions);
    const incoming = await this.incoming();
    const data = await this.accept(incoming);
    return { client, data, incoming };
  }

  close() {
    return this.control.close(1000, "done");
  }
}
