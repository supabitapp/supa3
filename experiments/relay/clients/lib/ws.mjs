import WebSocket from 'ws';
import { deferred, withDeadline } from './util.mjs';

export class HttpRejection extends Error {
  constructor(status, body) {
    super(`rejected before upgrade with HTTP ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

export const connectionStats = { attempts: 0, portExhaustion: 0 };

export class PortExhaustion extends Error {
  constructor(cause) {
    super(`local ephemeral port exhaustion (${cause.code}); stop and let TIME_WAIT clear`);
    this.code = cause.code;
  }
}

export function openWs(url, { timeoutMs = 5000, ...opts } = {}) {
  connectionStats.attempts++;
  const ws = new WebSocket(url, { perMessageDeflate: false, ...opts });
  ws.queue = new MessageQueue(ws);
  const d = deferred();
  ws.once('open', () => d.resolve(ws));
  ws.once('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => d.reject(new HttpRejection(res.statusCode, body)));
  });
  ws.once('error', (err) => {
    if (err.code === 'EADDRNOTAVAIL' || err.code === 'EADDRINUSE' || err.code === 'EMFILE') {
      connectionStats.portExhaustion++;
      d.reject(new PortExhaustion(err));
    } else {
      d.reject(err);
    }
  });
  return withDeadline(d.promise, timeoutMs, `open ${url}`);
}

export function trackClose(ws) {
  const d = deferred();
  ws.on('close', (code, reason) => d.resolve({ code, reason: reason.toString() }));
  ws.on('error', () => {});
  return d.promise;
}

export function nextMessage(ws, ms = 5000) {
  return withDeadline(new Promise((resolve, reject) => {
    const onMessage = (data, isBinary) => { cleanup(); resolve({ data: Buffer.from(data), isBinary }); };
    const onClose = (code, reason) => { cleanup(); reject(new Error(`closed ${code} ${reason} while waiting for message`)); };
    const onError = (err) => { cleanup(); reject(err); };
    const cleanup = () => { ws.off('message', onMessage); ws.off('close', onClose); ws.off('error', onError); };
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  }), ms, 'next message');
}

export class MessageQueue {
  constructor(ws) {
    this.items = [];
    this.waiters = [];
    this.closed = null;
    this.ws = ws;
    this.onMessage = (data, isBinary) => this.#push({ data: Buffer.from(data), isBinary });
    ws.on('message', this.onMessage);
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const w of this.waiters.splice(0)) w.reject(new Error(`closed ${code} ${this.closed.reason}`));
    });
    ws.on('error', () => {});
  }

  detach() {
    this.ws.off('message', this.onMessage);
    this.ws.queue = null;
    return this.items.splice(0);
  }

  #push(item) {
    const w = this.waiters.shift();
    if (w) w.resolve(item); else this.items.push(item);
  }

  next(ms = 5000) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.reject(new Error(`closed ${this.closed.code} ${this.closed.reason}`));
    const d = deferred();
    this.waiters.push(d);
    return withDeadline(d.promise, ms, 'queued message');
  }

  async nextJson(ms) {
    const { data } = await this.next(ms);
    return JSON.parse(data.toString());
  }
}

export function send(ws, data, binary) {
  return new Promise((resolve, reject) => ws.send(data, { binary }, (err) => (err ? reject(err) : resolve())));
}
