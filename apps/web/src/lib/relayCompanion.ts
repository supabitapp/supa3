import {
  RELAY_COMPANION_META_NAME,
  RELAY_COMPANION_REQUEST_LIMIT,
  canonicalRelayAddress,
} from "@supacode/shared/relay/protocol";
import { RelayCompanionReply } from "@supacode/contracts";
import { after } from "@supacode/shared/relay/timer";
import * as Schema from "effect/Schema";

const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(RelayCompanionReply));

export function isRelayCompanion(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector(`meta[name="${RELAY_COMPANION_META_NAME}"]`)?.getAttribute("content") ===
      "1"
  );
}

export function createRelayCompanionControl() {
  let socket: WebSocket | undefined;
  let connected: Promise<void> | undefined;
  let sequence = 0;
  let outstanding = 0;
  let disposed = false;
  let capacity: Promise<void> | undefined;
  let wakeCapacity: (() => void) | undefined;
  const origins = new Map<string, string>();
  const tails = new Map<string, Promise<void>>();
  const closing = new Map<string, { caller: Promise<string | undefined>; tail: Promise<void> }>();
  const pending = new Map<
    string,
    {
      socket: WebSocket;
      resolve: (origin: string | undefined) => void;
      reject: (error: Error) => void;
    }
  >();
  const connect = () => {
    if (disposed) throw new Error("The local relay companion is closed.");
    if (connected) return connected;
    const url = new URL("/__relay/control", location.href);
    url.protocol = "ws:";
    const current = new WebSocket(url);
    socket = current;
    connected = new Promise<void>((resolve, reject) => {
      const cancel = after(15_000, () => {
        current.close();
        fail();
      });
      current.addEventListener(
        "open",
        () => {
          cancel();
          resolve();
        },
        { once: true },
      );
      const fail = () => {
        cancel();
        const error = new Error("The local relay companion disconnected.");
        reject(error);
        if (socket !== current) return;
        socket = undefined;
        connected = undefined;
        origins.clear();
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      };
      current.addEventListener("close", fail);
      current.addEventListener("error", fail);
      current.addEventListener("message", (event) => {
        if (socket !== current) return;
        try {
          const reply = decodeReply(String(event.data));
          const request = pending.get(reply.id);
          if (!request || request.socket !== current) return;
          pending.delete(reply.id);
          if (reply.error) request.reject(new Error(reply.error));
          else request.resolve(reply.origin);
        } catch {
          current.close();
        }
      });
    });
    return connected;
  };
  const exchange = (current: WebSocket, action: "open" | "close", address: string) => {
    if (socket !== current || current.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Relay companion is not connected."));
    const id = String(++sequence);
    return new Promise<string | undefined>((resolve, reject) => {
      pending.set(id, { socket: current, resolve, reject });
      try {
        current.send(JSON.stringify({ id, action, address }));
      } catch (cause) {
        pending.delete(id);
        reject(cause instanceof Error ? cause : new Error("Companion request failed"));
      }
    });
  };
  return {
    async request(action: "open" | "close", input: string) {
      if (disposed) throw new Error("The local relay companion is closed.");
      const address = canonicalRelayAddress(input);
      if (!address) throw new Error("Not a relay address");
      const previous = tails.get(address);
      const existingClose = action === "close" ? closing.get(address) : undefined;
      if (existingClose && existingClose.tail === previous) return existingClose.caller;
      const cached = origins.get(address);
      if (action === "open" && !previous && cached && socket?.readyState === WebSocket.OPEN)
        return cached;
      let admitted = outstanding < RELAY_COMPANION_REQUEST_LIMIT;
      if (!admitted && !(action === "close" && (cached || previous)))
        throw new Error("Too many companion requests.");
      if (admitted) outstanding++;
      const caller = new Promise<string | undefined>((resolve, reject) => {
        let expired = false;
        const cancel = after(15_000, () => {
          expired = true;
          reject(new Error("The relay companion did not respond."));
        });
        const job = (previous ?? Promise.resolve())
          .then(async () => {
            if (expired && action === "open") return;
            if (action === "close" && !origins.has(address)) {
              resolve(undefined);
              return;
            }
            const ownerSocket = action === "close" ? socket : undefined;
            while (!admitted) {
              if (disposed) throw new Error("The local relay companion is closed.");
              if (outstanding < RELAY_COMPANION_REQUEST_LIMIT) {
                outstanding++;
                admitted = true;
              } else {
                capacity ??= new Promise<void>((resume) => {
                  wakeCapacity = resume;
                });
                await capacity;
              }
            }
            if (action === "close" && ownerSocket && socket !== ownerSocket) {
              resolve(undefined);
              return;
            }
            await connect();
            const current = socket;
            if (!current || current.readyState !== WebSocket.OPEN)
              throw new Error("Relay companion is not connected.");
            if (expired && action === "open") return;
            const origin = action === "open" ? origins.get(address) : undefined;
            if (origin) {
              resolve(origin);
              return;
            }
            if (action === "close") origins.delete(address);
            const resolved = await exchange(current, action, address);
            if (socket !== current) throw new Error("The local relay companion disconnected.");
            if (action === "open") {
              if (!resolved) throw new Error("The companion did not return a relay origin.");
              if (expired) {
                await exchange(current, "close", address);
              } else origins.set(address, resolved);
            }
            if (!expired) resolve(resolved);
          })
          .catch((cause) => {
            if (!expired)
              reject(cause instanceof Error ? cause : new Error("Companion request failed"));
          })
          .finally(() => {
            cancel();
            if (admitted) {
              outstanding--;
              const wake = wakeCapacity;
              capacity = undefined;
              wakeCapacity = undefined;
              wake?.();
            }
            if (tails.get(address) === job) tails.delete(address);
            if (closing.get(address)?.caller === caller) closing.delete(address);
          });
        tails.set(address, job);
      });
      if (action === "close") {
        const tail = tails.get(address);
        if (tail) closing.set(address, { caller, tail });
      }
      return caller;
    },
    close() {
      disposed = true;
      wakeCapacity?.();
      socket?.close();
    },
  };
}
