import {
  RELAY_COMPANION_META_NAME,
  RELAY_COMPANION_REQUEST_LIMIT,
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
  const pending = new Map<
    string,
    { resolve: (origin: string | undefined) => void; reject: (error: Error) => void }
  >();
  const connect = () => {
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
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      };
      current.addEventListener("close", fail);
      current.addEventListener("error", fail);
      current.addEventListener("message", (event) => {
        try {
          const reply = decodeReply(String(event.data));
          const request = pending.get(reply.id);
          if (!request) return;
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
  return {
    async request(action: "open" | "close", address: string) {
      await connect();
      if (!socket || socket.readyState !== WebSocket.OPEN)
        throw new Error("Relay companion is not connected.");
      if (pending.size >= RELAY_COMPANION_REQUEST_LIMIT)
        throw new Error("Too many companion requests.");
      const id = String(++sequence);
      return new Promise<string | undefined>((resolve, reject) => {
        const cancel = after(15_000, () => {
          pending.delete(id);
          reject(new Error("The relay companion did not respond."));
          socket?.close();
        });
        pending.set(id, {
          resolve: (origin) => {
            cancel();
            resolve(origin);
          },
          reject: (error) => {
            cancel();
            reject(error);
          },
        });
        try {
          socket!.send(JSON.stringify({ id, action, address }));
        } catch (cause) {
          pending
            .get(id)
            ?.reject(cause instanceof Error ? cause : new Error("Companion request failed"));
          pending.delete(id);
        }
      });
    },
    close() {
      socket?.close();
    },
  };
}
