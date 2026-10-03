import * as NodeCrypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  relayEndpointId,
  relayPublicKey,
  signRelayChallenge,
} from "@t3tools/shared/relay/protocol";
import { describe, expect, it } from "vite-plus/test";
import { relayLocalTarget, startRelayTransport } from "./transport.ts";

describe("relay local routing", () => {
  it("allows only the app API and RPC socket on the configured origin", () => {
    expect(relayLocalTarget("http://127.0.0.1:1000", "/api/auth/session", false).href).toBe(
      "http://127.0.0.1:1000/api/auth/session",
    );
    expect(relayLocalTarget("http://127.0.0.1:1000", "/ws?wsTicket=test", true).href).toBe(
      "ws://127.0.0.1:1000/ws?wsTicket=test",
    );
    for (const path of [
      "https://example.com/api/auth/session",
      "//example.com/api/test",
      "/\\example.com/api/test",
      "/api/../../",
      "/mcp",
      "/",
      "/api/x#fragment",
    ]) {
      expect(() => relayLocalTarget("http://127.0.0.1:1000", path, false)).toThrow();
    }
    expect(() => relayLocalTarget("http://127.0.0.1:1000", "/api/auth/session", true)).toThrow();
  });
});

it("registers the same identity again after the relay drops its control connection", async () => {
  const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => relay.once("listening", resolve));
  const address = relay.address();
  if (typeof address === "string" || address === null) throw new Error("No relay listener");
  const secret = NodeCrypto.randomBytes(32);
  const authenticated: unknown[] = [];
  const connections: WebSocket[] = [];
  relay.on("connection", (socket) => {
    connections.push(socket);
    socket.send(JSON.stringify({ type: "challenge", nonce: "test-challenge" }));
    socket.on("message", (raw) => {
      authenticated.push(JSON.parse(raw.toString()));
      socket.send(
        JSON.stringify({ type: "registered", endpointId: relayEndpointId(relayPublicKey(secret)) }),
      );
    });
  });
  let ready = Promise.withResolvers<void>();
  const states: boolean[] = [];
  const stop = startRelayTransport({
    secret,
    localOrigin: "http://127.0.0.1:1",
    fetch,
    relayUrl: `ws://127.0.0.1:${address.port}`,
    retryBaseMs: 1,
    onStatus: (connected) => {
      states.push(connected);
      if (connected) ready.resolve();
    },
  });
  try {
    await ready.promise;
    ready = Promise.withResolvers<void>();
    connections[0]!.terminate();
    await ready.promise;
    expect(states).toEqual([true, false, true]);
    expect(authenticated).toEqual(
      Array.from({ length: 2 }, () => ({
        type: "authenticate",
        signature: signRelayChallenge(secret, "test-challenge"),
      })),
    );
  } finally {
    stop();
    for (const socket of relay.clients) socket.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  }
});
