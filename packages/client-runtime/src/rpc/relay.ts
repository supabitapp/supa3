import {
  createRelayFetch,
  RelayWebSocket,
  type RelayClientOptions,
} from "@supacode/shared/relay/client";
import { parseRelayAddress } from "@supacode/shared/relay/protocol";
import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";

export function relayClientOptions(
  randomBytes: RelayClientOptions["randomBytes"] = (size: number) =>
    globalThis.crypto.getRandomValues(new Uint8Array(size)),
): RelayClientOptions {
  return {
    randomBytes,
    createSocket(url) {
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      return socket;
    },
  };
}
export const relayWebSocketLayer = (options = relayClientOptions()) =>
  Layer.succeed(Socket.WebSocketConstructor, (url) =>
    parseRelayAddress(url) ? new RelayWebSocket(url, options) : options.createSocket(url),
  );
export const relayFetch = (fetchImpl: typeof globalThis.fetch, options = relayClientOptions()) =>
  createRelayFetch(fetchImpl, options);
