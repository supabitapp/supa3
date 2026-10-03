import { generateHostKey } from '../lib/protocol.mjs';
import { connectHost } from '../lib/host.mjs';

const address = process.argv[2];
const count = Number(process.argv[3]);
const hosts = [];
for (let i = 0; i < count; i++) {
  const host = await connectHost(address, generateHostKey());
  hosts.push(host);
  (async () => {
    for (;;) {
      let incoming;
      try { incoming = await host.nextIncoming(24 * 3600 * 1000); } catch { return; }
      host.accept(incoming).then((socket) => {
        socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
        socket.on('error', () => {});
      }).catch(() => {});
    }
  })();
}
process.send({ type: 'ready', endpointIds: hosts.map((h) => h.key.endpointId) });
process.on('message', (msg) => { if (msg === 'exit') process.exit(0); });
