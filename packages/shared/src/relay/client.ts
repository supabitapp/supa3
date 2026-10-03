import { after } from "./timer.ts";
import { RelayResponse, type RelayRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { WebSocketLike, WebSocketEvent } from "effect/unstable/socket/Socket";
import {
  PUBLIC_RELAY_URL,
  createClientHandshake,
  parseRelayAddress,
  relayEndpointId,
  encodeBase64,
  decodeBase64,
  createRelayStream,
  type RelayStream,
} from "./protocol.ts";

const decodeResponse = Schema.decodeUnknownSync(RelayResponse);
type Listener = (event: WebSocketEvent) => void;
export interface RelayClientOptions {
  readonly createSocket: (url: string) => WebSocketLike;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly relayUrl?: string;
}

function connectChannel(
  address: string,
  options: RelayClientOptions,
  receive: (message: RelayResponse) => void,
  closed: (event: WebSocketEvent) => void,
) {
  const identity = parseRelayAddress(address);
  if (!identity) throw new Error("Not a relay address");
  const handshake = createClientHandshake(identity, options.randomBytes);
  let socket: WebSocketLike;
  try {
    socket = options.createSocket(
      `${options.relayUrl ?? PUBLIC_RELAY_URL}/v1/connect?endpointId=${relayEndpointId(identity)}`,
    );
  } catch (error) {
    handshake.destroy();
    throw error;
  }
  let stream: RelayStream | undefined;
  let settled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timeout = after(15_000, () => finish({ code: 1006, reason: "Relay handshake timed out" }));
  function finish(event: WebSocketEvent) {
    if (settled) return;
    settled = true;
    timeout();
    handshake.destroy();
    stream?.destroy();
    socket.close();
    rejectReady(new Error(event.reason || "Relay disconnected"));
    closed(event);
  }
  socket.addEventListener("open", () => socket.send(handshake.hello));
  socket.addEventListener("close", finish);
  socket.addEventListener("error", () => finish({ code: 1006, reason: "Relay connection failed" }));
  socket.addEventListener("message", (event) => {
    if (settled) return;
    try {
      if (!stream) {
        if (typeof event.data !== "string" || event.data.length > 4096)
          throw new Error("Invalid relay handshake");
        stream = createRelayStream(handshake.finish(event.data), (frame) => socket.send(frame));
        timeout();
        resolveReady();
        return;
      }
      if (!(event.data instanceof ArrayBuffer) && !(event.data instanceof Uint8Array))
        throw new Error("Invalid encrypted relay message");
      const raw = stream.receive(
        event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data),
      );
      if (raw !== null) receive(decodeResponse(JSON.parse(raw)));
    } catch {
      finish({ code: 1006, reason: "Relay authentication or transport failed" });
    }
  });
  return {
    ready,
    send(message: RelayRequest) {
      if (!stream || settled) throw new Error("Relay disconnected");
      stream.send(JSON.stringify(message));
    },
    close() {
      finish({ code: 1000, reason: "Closed" });
    },
  };
}

export function createRelayFetch(
  fetchImpl: typeof globalThis.fetch,
  options: RelayClientOptions,
): typeof globalThis.fetch {
  return async (input, init) => {
    const address =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const inline = /^data:([^,]*);base64,([A-Za-z0-9+/]*={0,2})$/.exec(address);
    if (inline) {
      const request = new Request(input, init);
      request.signal.throwIfAborted();
      return new Response(
        request.method === "HEAD"
          ? null
          : decodeBase64(inline[2]!.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")),
        {
          headers: { "content-type": inline[1]! },
        },
      );
    }
    if (!parseRelayAddress(address)) return fetchImpl(input, init);
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    return new Promise<Response>((resolve, reject) => {
      let done = false;
      const complete = (response?: Response, error?: unknown) => {
        if (done) return;
        done = true;
        timeout();
        request.signal.removeEventListener("abort", abort);
        channel.close();
        if (response) resolve(response);
        else reject(error ?? new Error("Relay disconnected"));
      };
      const abort = () => complete(undefined, request.signal.reason);
      const channel = connectChannel(
        address,
        options,
        (message) => {
          if (message.type === "http") {
            complete(
              new Response(
                [101, 204, 205, 304].includes(message.status) || request.method === "HEAD"
                  ? null
                  : decodeBase64(message.body),
                { status: message.status, headers: message.headers },
              ),
            );
          } else if (message.type === "error") complete(undefined, new Error(message.message));
          else complete(undefined, new Error("Unexpected relay response"));
        },
        (event) => complete(undefined, new Error(event.reason || "Relay disconnected")),
      );
      const timeout = after(60_000, () =>
        complete(undefined, new Error("Relay request timed out")),
      );
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) {
        abort();
        return;
      }
      void channel.ready
        .then(async () => {
          const method = request.method;
          if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method))
            throw new Error("Unsupported relay method");
          const body = new Uint8Array(await request.arrayBuffer());
          if (done) return;
          channel.send({
            type: "http",
            path: url.pathname + url.search,
            method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD",
            headers: Object.fromEntries(request.headers),
            body: encodeBase64(body),
          });
        })
        .catch((error: unknown) => complete(undefined, error));
    });
  };
}

export class RelayWebSocket implements WebSocketLike {
  readyState = 0;
  private readonly listeners = new Map<string, Map<Listener, boolean>>();
  private readonly channel: ReturnType<typeof connectChannel>;
  constructor(url: string, options: RelayClientOptions) {
    this.channel = connectChannel(
      url,
      options,
      (message) => {
        if (message.type === "open" && this.readyState === 0) {
          this.readyState = 1;
          this.emit("open", {});
        } else if (message.type === "data" && this.readyState === 1) {
          this.emit("message", {
            data: message.binary ? decodeBase64(message.data).buffer : message.data,
          });
        } else if (message.type === "error") {
          this.emit("error", {});
          this.channel.close();
        } else throw new Error("Unexpected relay socket response");
      },
      (event) => {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.emit("close", event);
      },
    );
    void this.channel.ready
      .then(() => {
        const address = new URL(url);
        this.channel.send({ type: "socket", path: address.pathname + address.search });
      })
      .catch(() => {
        this.emit("error", {});
        this.channel.close();
      });
  }
  private emit(type: string, event: WebSocketEvent) {
    for (const [listener, once] of this.listeners.get(type) ?? []) {
      if (once) this.listeners.get(type)?.delete(listener);
      listener({ ...event, type });
    }
  }
  addEventListener(type: string, listener: Listener, options?: { readonly once?: boolean }) {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Map();
      this.listeners.set(type, listeners);
    }
    listeners.set(listener, options?.once === true);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  close() {
    this.channel.close();
  }
  send(data: string | Uint8Array<ArrayBuffer>) {
    if (this.readyState !== 1) throw new Error("Relay socket is not open");
    this.channel.send({
      type: "data",
      data: typeof data === "string" ? data : encodeBase64(data),
      binary: typeof data !== "string",
    });
  }
}
