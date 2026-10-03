import { WebSocketServer } from "ws";

const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
server.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
  ws.on("error", () => {});
});
server.on("listening", () => process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`));
process.on("SIGTERM", () => process.exit(0));
