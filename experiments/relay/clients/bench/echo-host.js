import WebSocket from "ws";
import { Host, keyPair } from "../lib.js";

const [relayWs, countArg] = process.argv.slice(2);
const relay = { ws: relayWs };
const hosts = [];
for (let i = 0; i < Number(countArg ?? 1); i++) hosts.push(await Host.register(relay, keyPair()));
process.stdout.write(`${JSON.stringify({ endpointIds: hosts.map((h) => h.endpointId) })}\n`);

for (const host of hosts) {
  (async () => {
    for (;;) {
      let incoming;
      try {
        incoming = await host.incoming(1e9);
      } catch {
        return;
      }
      const ws = new WebSocket(host.acceptUrl(incoming), { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
      ws.on("error", () => {});
    }
  })();
}
process.on("SIGTERM", () => process.exit(0));
