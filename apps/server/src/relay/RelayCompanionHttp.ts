import { RELAY_COMPANION_META_NAME } from "@supacode/shared/relay/protocol";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RelayCompanion } from "./RelayCompanion.ts";
import { RelayCompanionRequest, RelayCompanionReply } from "@supacode/contracts";

const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(RelayCompanionRequest));
const encodeReply = Schema.encodeEffect(Schema.fromJsonString(RelayCompanionReply));

export function layer(staticDir: string) {
  const controls = Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const companion = yield* RelayCompanion;
      const server = yield* HttpServer.HttpServer;
      if (!("port" in server.address)) return;
      const origin = `http://127.0.0.1:${server.address.port}`;
      const crypto = yield* Crypto.Crypto;
      yield* router.add(
        "GET",
        "/__relay/control",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers.host !== new URL(origin).host || request.headers.origin !== origin)
            return HttpServerResponse.empty({ status: 403 });
          const owner = yield* crypto.randomUUIDv4;
          const owned = new Set<string>();
          yield* Effect.addFinalizer(() =>
            Effect.forEach([...owned], (address) => companion.close(address, owner), {
              discard: true,
            }).pipe(Effect.ignore),
          );
          const socket = yield* request.upgrade;
          const reader = yield* socket.reader;
          const writer = yield* socket.writer;
          const decoder = new TextDecoder("utf-8", { fatal: true });
          yield* Effect.forever(
            Effect.gen(function* () {
              for (const bytes of yield* reader.pull) {
                const raw = typeof bytes === "string" ? bytes : decoder.decode(bytes);
                if (raw.length > 4096)
                  return yield* Effect.die(new Error("Companion control message too large"));
                const input = yield* decodeInput(raw);
                const response = yield* Effect.gen(function* () {
                  if (input.action === "close") {
                    yield* companion.close(input.address, owner);
                    owned.delete(input.address);
                    return { id: input.id };
                  }
                  const origin = yield* companion.open(input.address, owner);
                  owned.add(input.address);
                  return { id: input.id, origin };
                }).pipe(
                  Effect.catch(() =>
                    Effect.succeed({
                      id: input.id,
                      error: "The relay endpoint could not be prepared.",
                    }),
                  ),
                );
                yield* writer.write(yield* encodeReply(response));
              }
            }),
          ).pipe(Effect.ignore);
          return HttpServerResponse.empty();
        }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
      );
    }),
  );
  const shell = HttpRouter.add(
    "GET",
    "/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const server = yield* HttpServer.HttpServer;
      if (
        !("port" in server.address) ||
        request.headers.host !== `127.0.0.1:${server.address.port}`
      )
        return HttpServerResponse.empty({ status: 421 });
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(staticDir);
      const pathname = new URL(request.url, "http://companion").pathname;
      const decoded = yield* Effect.try(() => decodeURIComponent(pathname));
      const candidate = path.resolve(root, `.${decoded}`);
      const real = yield* fs
        .realPath(candidate)
        .pipe(Effect.orElseSucceed(() => path.join(root, "index.html")));
      if (real !== root && !real.startsWith(root + path.sep))
        return HttpServerResponse.empty({ status: 404 });
      const entry = real === root ? path.join(root, "index.html") : real;
      if (entry === path.join(root, "index.html")) {
        const html = yield* fs.readFileString(entry);
        return HttpServerResponse.text(
          html.replace("<head>", `<head><meta name="${RELAY_COMPANION_META_NAME}" content="1">`),
          {
            contentType: "text/html",
            headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
          },
        );
      }
      return yield* HttpServerResponse.file(entry, {
        headers: { "x-content-type-options": "nosniff" },
      });
    }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 404 })))),
  );
  return Layer.merge(controls, shell);
}
