import { after, every } from "@t3tools/shared/relay/timer";
import * as NodeCrypto from "node:crypto";
import WebSocket from "ws";
import * as Schema from "effect/Schema";
import { RelayRequest, type RelayResponse } from "@t3tools/contracts";
import {
  PUBLIC_RELAY_URL,
  acceptClientHandshake,
  relayPublicKey,
  relayEndpointId,
  signRelayChallenge,
  encodeBase64,
  decodeBase64,
  createRelayStream,
  type RelayStream,
  MAX_RELAY_MESSAGE_BYTES,
} from "@t3tools/shared/relay/protocol";

const decodeRequest = Schema.decodeUnknownSync(RelayRequest);
const ControlEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("challenge"), nonce: Schema.String }),
  Schema.Struct({ type: Schema.Literal("registered"), endpointId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("incoming"),
    connectionId: Schema.String,
    token: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("closed"), connectionId: Schema.String }),
]);
const decodeControl = Schema.decodeUnknownSync(ControlEvent);
const allowedHeaders = new Set([
  "authorization",
  "content-type",
  "accept",
  "range",
  "x-t3-orchestration-protocol",
]);

export function relayLocalTarget(origin: string, path: string, socket: boolean): URL {
  const target = new URL(path, origin);
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    target.origin !== new URL(origin).origin ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new Error("Invalid relay target");
  }
  if (
    socket
      ? target.pathname !== "/ws"
      : !(
          target.pathname.startsWith("/api/") ||
          target.pathname === "/oauth/token" ||
          target.pathname === "/.well-known/t3/environment"
        )
  ) {
    throw new Error("Unsupported relay target");
  }
  if (socket) target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target;
}

function bridge(
  socket: WebSocket,
  secret: Uint8Array,
  origin: string,
  fetchRequest: typeof globalThis.fetch,
  adjustBufferedBytes: (delta: number) => void,
) {
  let stream: RelayStream | undefined;
  let local: WebSocket | undefined;
  let mode: "http" | "socket" | undefined;
  let closed = false;
  let ownedBytes = 0;
  let messageBytes = 0;
  const abort = new AbortController();
  let timeout = after(15_000, () => stop());
  const stop = () => {
    if (closed) return;
    closed = true;
    adjustBufferedBytes(-ownedBytes);
    ownedBytes = 0;
    timeout();
    abort.abort();
    stream?.destroy();
    local?.close();
    socket.close();
  };
  const send = (message: RelayResponse) => {
    if (!stream || closed) return;
    stream.send(JSON.stringify(message));
  };
  const fail = () => {
    try {
      send({ type: "error", message: "Relay request failed" });
    } catch {
      stop();
    } finally {
      stop();
    }
  };
  socket.on("error", stop);
  socket.on("close", stop);
  socket.on("message", (data, binary) => {
    try {
      if (!stream) {
        if (binary || data.toString().length > 4096) throw new Error("Invalid handshake");
        const accepted = acceptClientHandshake(data.toString(), secret, NodeCrypto.randomBytes);
        stream = createRelayStream(accepted.cipher, (frame) => socket.send(frame));
        timeout();
        timeout = after(60_000, stop);
        socket.send(accepted.welcome);
        return;
      }
      if (!binary) throw new Error("Unencrypted relay message");
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data;
      if (bytes.length > 25) {
        adjustBufferedBytes(bytes.length);
        ownedBytes += bytes.length;
        messageBytes += bytes.length;
      }
      const raw = stream.receive(bytes);
      if (raw === null) return;
      const request = decodeRequest(JSON.parse(raw));
      if (request.type === "data") {
        if (mode !== "socket" || local?.readyState !== WebSocket.OPEN)
          throw new Error("Socket not ready");
        if (local.bufferedAmount > MAX_RELAY_MESSAGE_BYTES)
          throw new Error("Local backpressure limit");
        const sentBytes = messageBytes;
        messageBytes = 0;
        local.send(request.binary ? decodeBase64(request.data) : request.data, () => {
          if (!closed) {
            adjustBufferedBytes(-sentBytes);
            ownedBytes -= sentBytes;
          }
        });
        return;
      }
      if (mode) throw new Error("Relay channel already used");
      mode = request.type;
      const target = relayLocalTarget(origin, request.path, request.type === "socket");
      timeout();
      if (request.type === "socket") {
        local = new WebSocket(target, {
          handshakeTimeout: 10_000,
          maxPayload: MAX_RELAY_MESSAGE_BYTES,
        });
        local.on("open", () => {
          adjustBufferedBytes(-ownedBytes);
          ownedBytes = 0;
          messageBytes = 0;
          send({ type: "open" });
        });
        local.on("message", (message, isBinary) => {
          try {
            const bytes = Array.isArray(message)
              ? Buffer.concat(message)
              : message instanceof ArrayBuffer
                ? new Uint8Array(message)
                : message;
            send({
              type: "data",
              data: isBinary ? encodeBase64(bytes) : message.toString(),
              binary: isBinary,
            });
          } catch {
            stop();
          }
        });
        local.on("close", stop);
        local.on("error", fail);
      } else {
        timeout = after(60_000, stop);
        const headers = Object.fromEntries(
          Object.entries(request.headers).filter(([key]) => allowedHeaders.has(key.toLowerCase())),
        );
        void (async () => {
          const response = await fetchRequest(target, {
            method: request.method,
            headers,
            ...(request.method === "GET" || request.method === "HEAD"
              ? {}
              : { body: decodeBase64(request.body) }),
            redirect: "error",
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
          });
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (reader) {
            try {
              for (;;) {
                const item = await reader.read();
                if (item.done) break;
                size += item.value.length;
                if (size > MAX_RELAY_MESSAGE_BYTES * 0.7)
                  throw new Error("Relay response too large");
                chunks.push(item.value);
              }
            } finally {
              await reader.cancel();
            }
          }
          const responseHeaders: Record<string, string> = {};
          for (const name of ["content-type", "content-range", "accept-ranges", "cache-control"]) {
            const value = response.headers.get(name);
            if (value !== null) responseHeaders[name] = value;
          }
          send({
            type: "http",
            status: response.status,
            headers: responseHeaders,
            body: encodeBase64(Buffer.concat(chunks)),
          });
        })().catch(fail);
      }
    } catch {
      fail();
    }
  });
  return stop;
}

export function startRelayTransport(input: {
  readonly secret: Uint8Array;
  readonly fetch: typeof globalThis.fetch;
  readonly localOrigin: string;
  readonly relayUrl?: string;
  readonly onStatus?: (connected: boolean) => void;
  readonly retryBaseMs?: number;
}) {
  const relay = input.relayUrl ?? PUBLIC_RELAY_URL;
  const publicKey = relayPublicKey(input.secret);
  const endpointId = relayEndpointId(publicKey);
  let stopped = false;
  let control: WebSocket | undefined;
  let retry: (() => void) | undefined;
  let attempts = 0;
  let bufferedBytes = 0;
  const adjustBufferedBytes = (delta: number) => {
    if (bufferedBytes + delta > 256 * 1024 * 1024)
      throw new Error("Relay receive capacity exceeded");
    bufferedBytes += delta;
  };
  const pairs = new Map<string, () => void>();
  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(`${relay}/v1/control?publicKey=${encodeBase64(publicKey)}`, {
      handshakeTimeout: 10_000,
      maxPayload: 16_384,
    });
    control = ws;
    let alive = true;
    let registered = false;
    const readyTimeout = after(15_000, () => ws.terminate());
    const heartbeat = every(15_000, () => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    });
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("error", () => ws.close());
    ws.on("close", () => {
      readyTimeout();
      heartbeat();
      if (control !== ws) return;
      input.onStatus?.(false);
      for (const stop of pairs.values()) stop();
      pairs.clear();
      if (!stopped)
        retry = after(
          Math.min(30_000, (input.retryBaseMs ?? 1000) * 2 ** Math.min(attempts++, 5)) *
            (0.8 + NodeCrypto.randomInt(401) / 1000),
          connect,
        );
    });
    ws.on("message", (data) => {
      if (control !== ws || stopped) return;
      try {
        const event = decodeControl(JSON.parse(data.toString()));
        if (event.type === "challenge" && !registered) {
          ws.send(
            JSON.stringify({
              type: "authenticate",
              signature: signRelayChallenge(input.secret, event.nonce),
            }),
          );
        } else if (event.type === "registered" && event.endpointId === endpointId) {
          registered = true;
          attempts = 0;
          readyTimeout();
          input.onStatus?.(true);
        } else if (event.type === "incoming" && registered) {
          if (pairs.size >= 64 || pairs.has(event.connectionId)) return;
          const params = new URLSearchParams({
            endpointId,
            connectionId: event.connectionId,
            token: event.token,
          });
          const socket = new WebSocket(`${relay}/v1/accept?${params}`, {
            handshakeTimeout: 10_000,
            maxPayload: 65536,
          });
          const stop = bridge(
            socket,
            input.secret,
            input.localOrigin,
            input.fetch,
            adjustBufferedBytes,
          );
          pairs.set(event.connectionId, stop);
          socket.on("close", () => {
            if (pairs.get(event.connectionId) === stop) pairs.delete(event.connectionId);
          });
        } else if (event.type === "closed") {
          pairs.get(event.connectionId)?.();
          pairs.delete(event.connectionId);
        } else throw new Error("Invalid relay control event");
      } catch {
        ws.close();
      }
    });
  };
  connect();
  return () => {
    stopped = true;
    retry?.();
    control?.close();
    for (const stop of pairs.values()) stop();
    pairs.clear();
    input.onStatus?.(false);
  };
}
