import { Duplex } from 'node:stream';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deferred, withDeadline } from './util.mjs';

export class WsDuplex extends Duplex {
  constructor(ws, { intercept } = {}) {
    super();
    this.ws = ws;
    this.intercept = intercept;
    const deliver = (data) => {
      const chunks = this.intercept ? this.intercept(Buffer.from(data)) : [Buffer.from(data)];
      for (const chunk of chunks) this.push(chunk);
    };
    if (ws.queue) {
      const queue = ws.queue;
      ws.queue = null;
      (async () => {
        for (;;) {
          let item;
          try { item = await queue.next(24 * 3600 * 1000); } catch { this.push(null); return; }
          deliver(item.data);
        }
      })();
    } else {
      ws.on('message', deliver);
      ws.on('close', () => this.push(null));
    }
    ws.on('error', (err) => this.destroy(err));
  }

  _write(chunk, _enc, cb) {
    this.ws.send(chunk, { binary: true }, cb);
  }

  _read() {}

  _final(cb) {
    this.ws.close(1000);
    cb();
  }
}

export function makeTestIdentity(cn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passio-relay-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`], { stdio: 'ignore' });
  const identity = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), cn };
  fs.rmSync(dir, { recursive: true, force: true });
  const x509 = new crypto.X509Certificate(identity.cert);
  identity.fingerprint256 = x509.fingerprint256;
  return identity;
}

export function serveTls(ws, identity, onRequest) {
  const duplex = new WsDuplex(ws);
  const socket = new tls.TLSSocket(duplex, {
    isServer: true,
    secureContext: tls.createSecureContext({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.3' }),
  });
  socket.on('data', (data) => socket.write(onRequest(data)));
  socket.on('error', () => {});
  return socket;
}

export function connectTls(ws, pinned, { intercept, servername = pinned.cn } = {}) {
  const duplex = new WsDuplex(ws, { intercept });
  const d = deferred();
  const socket = tls.connect({
    socket: duplex,
    servername,
    ca: [pinned.cert],
    minVersion: 'TLSv1.3',
    checkServerIdentity: (_host, cert) =>
      cert.fingerprint256 === pinned.fingerprint256 ? undefined : new Error(`certificate fingerprint mismatch: ${cert.fingerprint256}`),
  });
  socket.once('secureConnect', () => d.resolve(socket));
  socket.once('error', (err) => d.reject(err));
  return withDeadline(d.promise, 5000, 'tls handshake').then((s) => s);
}

export function tlsRequest(socket, payload, ms = 5000) {
  const d = deferred();
  const onData = (data) => { cleanup(); d.resolve(data); };
  const onError = (err) => { cleanup(); d.reject(err); };
  const onClose = () => { cleanup(); d.reject(new Error('tls socket closed before response')); };
  const cleanup = () => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  socket.write(payload);
  return withDeadline(d.promise, ms, 'tls response');
}
