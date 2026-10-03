import * as NodeCrypto from "node:crypto";
import WebSocket from "ws";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { createRelayFetch, RelayWebSocket } from "@t3tools/shared/relay/client";
import { PUBLIC_RELAY_URL, relayHttpBaseUrl, relayPublicKey } from "@t3tools/shared/relay/protocol";
import { startRelayTransport } from "./transport.ts";

it.live.skipIf(process.env.SUPACODE_RELAY_E2E !== "1")(
  "pairs through the relay, preserves auth and payloads, and reconnects after host loss",
  () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        HttpServer.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.url.startsWith("/ws")) {
              const socket = yield* request.upgrade;
              const writer = yield* socket.writer;
              const reader = yield* socket.reader;
              return yield* Effect.forever(Effect.flatMap(reader.pull, writer.writeAll));
            }
            if (request.headers.authorization !== "Bearer relay-test-credential")
              return HttpServerResponse.empty({ status: 401 });
            return request.method === "POST"
              ? HttpServerResponse.uint8Array(new Uint8Array(yield* request.arrayBuffer))
              : HttpServerResponse.text("authorized");
          }),
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      );
      const address = Context.get(context, HttpServer.HttpServer).address;
      if (typeof address === "string" || !("port" in address)) throw new Error("No test listener");
      yield* Effect.promise(async () => {
        const secret = NodeCrypto.randomBytes(32);
        const base = relayHttpBaseUrl(relayPublicKey(secret));
        const relayUrl = process.env.SUPACODE_RELAY_TEST_URL ?? PUBLIC_RELAY_URL;
        const options = {
          relayUrl,
          randomBytes: NodeCrypto.randomBytes,
          createSocket(url: string) {
            const socket = new WebSocket(url);
            socket.binaryType = "arraybuffer";
            return socket;
          },
        };
        const relayFetch = createRelayFetch(fetch, options);
        const start = async () => {
          const ready = Promise.withResolvers<void>();
          const stop = startRelayTransport({
            secret,
            localOrigin: `http://127.0.0.1:${address.port}`,
            fetch,
            relayUrl,
            retryBaseMs: 100,
            onStatus: (connected) => {
              if (connected) ready.resolve();
            },
          });
          await ready.promise;
          return stop;
        };
        let stop: (() => void) | undefined;
        let client: RelayWebSocket | undefined;
        try {
          stop = await start();
          expect((await relayFetch(new URL("/api/test", base))).status).toBe(401);
          const payload = NodeCrypto.randomBytes(
            Number(process.env.SUPACODE_RELAY_TEST_BYTES ?? 400_000),
          );
          const response = await relayFetch(new URL("/api/test", base), {
            method: "POST",
            headers: { authorization: "Bearer relay-test-credential" },
            body: payload,
          });
          expect(response.status).toBe(200);
          expect(Buffer.from(await response.arrayBuffer()).equals(payload)).toBe(true);
          client = new RelayWebSocket(base.replace("https:", "wss:") + "ws", options);
          await new Promise<void>((resolve, reject) => {
            client!.addEventListener("open", () => resolve());
            client!.addEventListener("error", () => reject(new Error("Relay socket failed")));
          });
          const echoed = new Promise<unknown>((resolve) =>
            client!.addEventListener("message", (event) => resolve(event.data), { once: true }),
          );
          client.send("test message");
          expect(await echoed).toBe("test message");
          const closed = new Promise<void>((resolve) =>
            client!.addEventListener("close", () => resolve(), { once: true }),
          );
          stop();
          await closed;
          stop = await start();
          expect(
            await (
              await relayFetch(new URL("/api/test", base), {
                headers: { authorization: "Bearer relay-test-credential" },
              })
            ).text(),
          ).toBe("authorized");
          const abort = new AbortController();
          abort.abort();
          await expect(
            relayFetch(new URL("/api/test", base), { signal: abort.signal }),
          ).rejects.toThrow();
        } finally {
          client?.close();
          stop?.();
        }
      });
    }).pipe(Effect.scoped),
  60_000,
);
