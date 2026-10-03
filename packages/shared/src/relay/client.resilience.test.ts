import * as NodeCrypto from "node:crypto";
import type { RelayResponse } from "@supacode/contracts";
import type { WebSocketEvent, WebSocketLike } from "effect/unstable/socket/Socket";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createRelayFetch, RelayWebSocket } from "./client.ts";
import {
  acceptClientHandshake,
  createRelayStream,
  encodeBase64,
  relayHttpBaseUrl,
  relayPublicKey,
  type RelayStream,
} from "./protocol.ts";

const clock = vi.hoisted(() => new Map<() => void, number>());
vi.mock(import("./timer.ts"), () => ({
  after: (milliseconds: number, callback: () => void) => {
    clock.set(callback, milliseconds);
    return () => clock.delete(callback);
  },
}));
afterEach(() => clock.clear());

function makeNetwork() {
  const secret = NodeCrypto.randomBytes(32);
  const address = relayHttpBaseUrl(relayPublicKey(secret));
  const connections: ReturnType<typeof connect>[] = [];
  function connect() {
    const listeners = new Map<string, Set<(event: WebSocketEvent) => void>>();
    const toHost: (string | Uint8Array)[] = [];
    const toClient: (string | Uint8Array)[] = [];
    const received: string[] = [];
    const sending = Promise.withResolvers<void>();
    let host: RelayStream | undefined;
    const socket = {
      readyState: 0,
      addEventListener(type, listener) {
        const group = listeners.get(type) ?? new Set();
        group.add(listener);
        listeners.set(type, group);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      send(data) {
        toHost.push(data);
        if (typeof data !== "string") sending.resolve();
      },
      close() {
        if (socket.readyState === 3) return;
        socket.readyState = 3;
        host?.destroy();
        toHost.length = 0;
        toClient.length = 0;
        emit("close", { code: 1006, reason: "Network interrupted" });
      },
    } satisfies WebSocketLike;
    function emit(type: string, event: WebSocketEvent) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    }
    function deliverToHost() {
      const frame = toHost.shift();
      if (frame === undefined) return;
      if (typeof frame === "string") {
        const accepted = acceptClientHandshake(frame, secret, NodeCrypto.randomBytes);
        host = createRelayStream(accepted.cipher, (data) => toClient.push(data));
        toClient.push(accepted.welcome);
      } else {
        const value = host!.receive(frame);
        if (value !== null) received.push(value);
      }
    }
    function deliverToClient() {
      const frame = toClient.shift();
      if (frame !== undefined) emit("message", { data: frame });
    }
    return {
      socket,
      received,
      toHost,
      toClient,
      async handshake() {
        socket.readyState = 1;
        emit("open", {});
        deliverToHost();
        deliverToClient();
        await sending.promise;
      },
      deliverToHost,
      deliverToClient,
      pump() {
        while (toHost.length || toClient.length) {
          deliverToHost();
          deliverToClient();
        }
      },
      respond(message: RelayResponse) {
        host!.send(JSON.stringify(message));
      },
    };
  }
  const options = {
    randomBytes: NodeCrypto.randomBytes,
    createSocket() {
      const connection = connect();
      connections.push(connection);
      return connection.socket;
    },
  };
  return { address, connections, options, fetch: createRelayFetch(fetch, options) };
}

it("resumes a fragmented upload and download after delivery stalls without changing bytes", async () => {
  const network = makeNetwork();
  const payload = NodeCrypto.randomBytes(1_000_000);
  const pending = network.fetch(new URL("/api/upload", network.address), {
    method: "POST",
    body: payload,
  });
  const link = network.connections[0]!;
  await link.handshake();
  expect(link.toHost).toHaveLength(8);
  for (let frame = 0; frame < 8; frame++) link.deliverToHost();
  expect(link.received).toEqual([]);
  expect(link.toHost).toHaveLength(0);
  expect(link.toClient).toHaveLength(8);
  link.pump();
  expect(link.received).toHaveLength(1);
  expect(JSON.parse(link.received[0]!).body).toBe(encodeBase64(payload));
  link.respond({ type: "http", status: 200, headers: {}, body: encodeBase64(payload) });
  expect(link.toClient).toHaveLength(8);
  for (let frame = 0; frame < 8; frame++) link.deliverToClient();
  expect(link.toClient).toHaveLength(0);
  expect(link.toHost).toHaveLength(8);
  link.pump();
  expect(Buffer.from(await (await pending).arrayBuffer()).equals(payload)).toBe(true);
  expect(link.socket.readyState).toBe(3);
  expect(clock.size).toBe(0);
});

it.each(["handshake", "upload", "download"] as const)(
  "rejects a disconnect during %s without retrying a request or accepting partial data",
  async (phase) => {
    const network = makeNetwork();
    const pending = network.fetch(new URL("/api/upload", network.address), {
      method: "POST",
      body: NodeCrypto.randomBytes(1_000_000),
    });
    const rejected = expect(pending).rejects.toThrow("Network interrupted");
    const link = network.connections[0]!;
    if (phase !== "handshake") {
      await link.handshake();
      link.deliverToHost();
      if (phase === "download") {
        link.pump();
        link.respond({ type: "http", status: 200, headers: {}, body: "a".repeat(1_000_000) });
        link.deliverToClient();
      }
    }
    link.socket.close();
    await rejected;
    expect(link.received).toHaveLength(phase === "download" ? 1 : 0);
    expect(network.connections).toHaveLength(1);
    expect(clock.size).toBe(0);
  },
);

it.each(["handshake", "response"] as const)("times out a silent %s stall", async (phase) => {
  const network = makeNetwork();
  const pending = network.fetch(new URL("/api/test", network.address));
  const rejected = expect(pending).rejects.toThrow(
    phase === "handshake" ? "Relay handshake timed out" : "Relay request timed out",
  );
  const link = network.connections[0]!;
  if (phase === "response") {
    await link.handshake();
    link.pump();
  }
  const milliseconds = phase === "handshake" ? 15_000 : 60_000;
  const deadline = [...clock].find(([, duration]) => duration === milliseconds);
  expect(deadline).toBeDefined();
  deadline![0]();
  await rejected;
  expect(link.socket.readyState).toBe(3);
  expect(clock.size).toBe(0);
});

it("cancels an in-flight upload and releases its channel", async () => {
  const network = makeNetwork();
  const abort = new AbortController();
  const pending = network.fetch(new URL("/api/upload", network.address), {
    method: "POST",
    body: NodeCrypto.randomBytes(1_000_000),
    signal: abort.signal,
  });
  const rejected = expect(pending).rejects.toThrow("Upload cancelled");
  const link = network.connections[0]!;
  await link.handshake();
  link.deliverToHost();
  abort.abort(new Error("Upload cancelled"));
  await rejected;
  expect(link.received).toEqual([]);
  expect(link.socket.readyState).toBe(3);
  expect(clock.size).toBe(0);
});

it("opens a fresh encrypted socket after a disconnect without replaying queued messages", async () => {
  const network = makeNetwork();
  const url = network.address.replace("https:", "wss:") + "ws";
  const first = new RelayWebSocket(url, network.options);
  const closed = vi.fn();
  first.addEventListener("close", closed, { once: true });
  const old = network.connections[0]!;
  await old.handshake();
  old.pump();
  old.respond({ type: "open" });
  old.pump();
  first.send("x".repeat(1_000_000));
  old.deliverToHost();
  old.socket.close();
  expect(first.readyState).toBe(3);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(() => first.send("after disconnect")).toThrow();
  const second = new RelayWebSocket(url, network.options);
  const messages = vi.fn();
  second.addEventListener("message", messages);
  const fresh = network.connections[1]!;
  await fresh.handshake();
  fresh.pump();
  fresh.respond({ type: "open" });
  fresh.pump();
  second.send("fresh message");
  fresh.pump();
  expect(fresh.received.map((message) => JSON.parse(message))).toEqual([
    { type: "socket", path: "/ws" },
    { type: "data", data: "fresh message", binary: false },
  ]);
  fresh.respond({ type: "data", data: "reply", binary: false });
  fresh.pump();
  expect(messages).toHaveBeenCalledExactlyOnceWith({ type: "message", data: "reply" });
  second.close();
  expect(clock.size).toBe(0);
});
