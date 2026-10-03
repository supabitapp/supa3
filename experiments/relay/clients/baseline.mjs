import { WebSocketServer } from 'ws';
const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
server.on('connection', ws => {
  ws.on('error', () => {});
  ws.on('message', (data, binary) => ws.send(data, { binary }));
});
server.on('listening', () => console.log(JSON.stringify({ event: 'listening', address: `127.0.0.1:${server.address().port}` })));
process.on('SIGTERM', () => {
  for (const ws of server.clients) ws.terminate();
  server.close(() => process.exit(0));
});
