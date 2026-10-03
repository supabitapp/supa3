import assert from 'node:assert/strict';
import test from 'node:test';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePair, deadline, host, pair, startRelay } from './support.mjs';

class WebSocketStream extends Duplex {
  constructor(ws) {
    super();
    this.ws = ws;
    this.mode = null;
    this.changed = false;
    this.records = Buffer.alloc(0);
    ws.inbox.messages.length = 0;
    ws.on('message', data => {
      ws.inbox.messages.length = 0;
      if (!this.push(data)) ws.pause();
    });
    ws.on('close', () => this.push(null));
    ws.on('error', error => this.destroy(error));
    this.on('error', () => {});
  }

  _read() { this.ws.resume(); }

  _write(chunk, _, callback) {
    this.records = Buffer.concat([this.records, chunk]);
    const frames = [];
    while (this.records.length >= 5) {
      const length = 5 + this.records.readUInt16BE(3);
      if (this.records.length < length) break;
      const record = Buffer.from(this.records.subarray(0, length));
      this.records = this.records.subarray(length);
      if (this.mode && !this.changed && record[0] === 23) {
        this.changed = true;
        if (this.mode === 'modify') record[record.length - 1] ^= 1;
        frames.push(record);
        if (this.mode === 'replay') frames.push(record);
      } else frames.push(record);
    }
    if (!frames.length) return callback();
    let left = frames.length;
    let finished = false;
    for (const frame of frames) this.ws.send(frame, { binary: true }, error => {
      if (finished) return;
      if (error || --left === 0) { finished = true; callback(error); }
    });
  }

  _final(callback) { callback(); }
}

async function certificate(directory, name) {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  await promisify(execFile)('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost']);
  return { key: await readFile(keyPath), cert: await readFile(certPath) };
}

function tlsPair(p, credentials, pin) {
  const serverStream = new WebSocketStream(p.accepted);
  const clientStream = new WebSocketStream(p.client);
  const listener = tls.createServer({ ...credentials, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
  listener.on('tlsClientError', () => {});
  const serverReady = once(listener, 'secureConnection').then(([server]) => {
    server.on('error', () => {});
    return server;
  });
  listener.emit('connection', serverStream);
  const client = tls.connect({
    socket: clientStream, servername: 'localhost', ca: credentials.cert,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true,
    checkServerIdentity(name, cert) {
      const error = tls.checkServerIdentity(name, cert);
      if (error) return error;
      const actual = createHash('sha256').update(cert.raw).digest('hex');
      if (actual !== pin) return new Error('host certificate pin mismatch');
    }
  });
  client.on('error', () => {});
  return { client, server: null, serverReady, clientStream, serverStream };
}

test('endpoint TLS 1.3: pinned identity, encrypted exchange, tampering, replay, and fresh reconnect', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'passio-endpoint-tls-'));
  const relay = await startRelay();
  t.after(async () => { await relay.stop(); await rm(directory, { recursive: true, force: true }); });
  const credentials = await certificate(directory, 'host');
  const context = tls.createSecureContext(credentials);
  assert.ok(context);
  const { X509Certificate } = await import('node:crypto');
  const pin = createHash('sha256').update(new X509Certificate(credentials.cert).raw).digest('hex');
  const h = await host(relay);
  for (const mode of ['success', 'wrong-identity', 'modify', 'replay', 'reconnect']) {
    const p = await pair(relay, h);
    const peers = tlsPair(p, credentials, mode === 'wrong-identity' ? '0'.repeat(64) : pin);
    t.after(() => { peers.client.destroy(); peers.server?.destroy(); peers.clientStream.destroy(); peers.serverStream.destroy(); });
    if (mode === 'wrong-identity') {
      const [error] = await deadline(once(peers.client, 'error'), 7000, `${mode} rejection`);
      assert.match(error.message, /pin mismatch/);
      assert.equal(peers.client.authorized, false);
    } else {
      await deadline(once(peers.client, 'secureConnect'), 7000, `${mode} handshake`);
      peers.server = await deadline(peers.serverReady, 7000, `${mode} server handshake`);
      assert.equal(peers.client.getProtocol(), 'TLSv1.3');
      assert.equal(peers.client.authorized, true);
      const received = [];
      peers.server.on('data', data => received.push(data.toString()));
      if (mode === 'modify' || mode === 'replay') {
        peers.clientStream.mode = mode;
        const rejected = once(peers.server, 'error');
        peers.client.write(`encrypted ${mode}`);
        const [error] = await deadline(rejected, 7000, `${mode} record rejection`);
        assert.match(error.code, /BAD_RECORD_MAC|DECRYPTION_FAILED/);
        assert.equal(peers.clientStream.changed, true);
        assert.deepEqual(received, mode === 'modify' ? [] : ['encrypted replay']);
      } else {
        const request = once(peers.server, 'data');
        peers.client.write('private request');
        assert.equal((await deadline(request, 7000, `${mode} request`))[0].toString(), 'private request');
        const response = once(peers.client, 'data');
        peers.server.write('private response');
        assert.equal((await deadline(response, 7000, `${mode} response`))[0].toString(), 'private response');
      }
    }
    await closePair(p, h);
    peers.client.destroy();
    peers.server?.destroy();
  }
  const report = JSON.stringify({ stdout: relay.stdout, stderr: relay.stderr, metrics: await relay.metrics() });
  assert.ok(!report.includes('private request'));
  assert.ok(!report.includes('PRIVATE KEY'));
});
