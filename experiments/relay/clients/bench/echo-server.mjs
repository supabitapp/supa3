import { WebSocketServer } from 'ws';

const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
server.on('connection', (socket) => {
  socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
  socket.on('error', () => {});
});
server.on('listening', () => process.send({ type: 'ready', port: server.address().port }));
process.on('message', (msg) => { if (msg === 'exit') process.exit(0); });
