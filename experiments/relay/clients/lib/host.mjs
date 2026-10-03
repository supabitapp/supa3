import { openWs, send } from './ws.mjs';
import { signChallenge, urls } from './protocol.mjs';
import { deferred, withDeadline } from './util.mjs';

export async function connectHost(address, key, { signature } = {}) {
  const ws = await openWs(urls.control(address, key.publicKey));
  const host = new HostControl(ws, address, key);
  const challenge = await host.queue.nextJson();
  if (challenge.type !== 'challenge') throw new Error(`expected challenge, got ${JSON.stringify(challenge)}`);
  host.nonce = challenge.nonce;
  host.signature = signature ? signature(challenge.nonce) : signChallenge(key, challenge.nonce);
  await send(ws, JSON.stringify({ type: 'authenticate', signature: host.signature }));
  const registered = await host.queue.nextJson();
  if (registered.type !== 'registered' || registered.endpointId !== key.endpointId) {
    throw new Error(`expected registered, got ${JSON.stringify(registered)}`);
  }
  host.startDispatch();
  return host;
}

export async function openControl(address, key) {
  const ws = await openWs(urls.control(address, key.publicKey));
  const host = new HostControl(ws, address, key);
  const challenge = await host.queue.nextJson();
  host.nonce = challenge.nonce;
  return host;
}

export class HostControl {
  constructor(ws, address, key) {
    this.ws = ws;
    this.address = address;
    this.key = key;
    this.queue = ws.queue;
    this.incoming = [];
    this.incomingWaiters = [];
    this.closedEvents = [];
    this.closedWaiters = [];
    this.closeInfo = new Promise((resolve) => ws.on('close', (code, reason) => {
      const err = new Error(`control socket closed ${code} ${reason}`);
      for (const w of [...this.incomingWaiters.splice(0), ...this.closedWaiters.splice(0)]) w.reject(err);
      resolve({ code, reason: reason.toString() });
    }));
  }

  startDispatch() {
    const loop = async () => {
      for (;;) {
        let record;
        try { record = await this.queue.nextJson(24 * 3600 * 1000); } catch { return; }
        if (record.type === 'incoming') this.#deliver(this.incoming, this.incomingWaiters, record);
        else if (record.type === 'closed') this.#deliver(this.closedEvents, this.closedWaiters, record);
      }
    };
    loop();
  }

  #deliver(items, waiters, record) {
    const w = waiters.shift();
    if (w) w.resolve(record); else items.push(record);
  }

  #take(items, waiters, ms, label) {
    if (items.length) return Promise.resolve(items.shift());
    const d = deferred();
    waiters.push(d);
    return withDeadline(d.promise, ms, label);
  }

  nextIncoming(ms = 5000) { return this.#take(this.incoming, this.incomingWaiters, ms, 'incoming record'); }
  nextClosed(ms = 5000) { return this.#take(this.closedEvents, this.closedWaiters, ms, 'closed record'); }

  acceptUrl(incoming, overrides = {}) {
    const { endpointId = this.key.endpointId, connectionId = incoming.connectionId, token = incoming.token } = overrides;
    return urls.accept(this.address, endpointId, connectionId, token);
  }

  accept(incoming, overrides) {
    return openWs(this.acceptUrl(incoming, overrides));
  }

  async acceptNext(ms) {
    const incoming = await this.nextIncoming(ms);
    return { incoming, socket: await this.accept(incoming) };
  }

  close(code, reason) { this.ws.close(code, reason); return this.closeInfo; }
}

export function connectClient(address, endpointId, opts) {
  return openWs(urls.connect(address, endpointId), opts);
}

export async function pair(relay, host) {
  const clientPromise = connectClient(relay.address, host.key.endpointId);
  const { incoming, socket: hostSocket } = await host.acceptNext();
  const client = await clientPromise;
  return { client, hostSocket, incoming };
}
