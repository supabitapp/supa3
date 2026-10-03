import http from 'node:http';
import crypto from 'node:crypto';
import { deferred, withDeadline } from './util.mjs';

export function openRawWs(url, { timeoutMs = 5000 } = {}) {
  const u = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');
  const d = deferred();
  const req = http.request({
    host: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
    },
  });
  req.on('upgrade', (_res, socket) => {
    const closed = deferred();
    const frames = [];
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 2) return;
        const opcode = buffered[0] & 0x0f;
        let len = buffered[1] & 0x7f;
        let offset = 2;
        if (len === 126) { if (buffered.length < 4) return; len = buffered.readUInt16BE(2); offset = 4; }
        else if (len === 127) { if (buffered.length < 10) return; len = Number(buffered.readBigUInt64BE(2)); offset = 10; }
        if (buffered.length < offset + len) return;
        frames.push({ opcode, payload: buffered.subarray(offset, offset + len) });
        buffered = buffered.subarray(offset + len);
      }
    });
    socket.on('close', () => closed.resolve(frames));
    socket.on('error', () => {});
    d.resolve({ socket, closed: closed.promise, frames });
  });
  req.on('response', (res) => d.reject(new Error(`HTTP ${res.statusCode}`)));
  req.on('error', (err) => d.reject(err));
  req.end();
  return withDeadline(d.promise, timeoutMs, 'raw websocket upgrade');
}
