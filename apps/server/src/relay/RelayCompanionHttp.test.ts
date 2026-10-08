// @effect-diagnostics nodeBuiltinImport:off - verifies real browser control upgrades.
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RELAY_COMPANION_REQUEST_LIMIT } from "@supacode/shared/relay/protocol";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpRouter, HttpServer } from "effect/http";
import WebSocket from "ws";
import { RelayCompanion, RelayCompanionError } from "./RelayCompanion.ts";
import { layer } from "./RelayCompanionHttp.ts";

const platform = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));
const identity = `https://${"11".repeat(16)}.${"22".repeat(16)}.relay.supacode.invalid`;
const address = `${identity}/`;
const foreignHostStatus = (origin: string) =>
  new Promise<number>((resolve, reject) => {
    NodeHttp.get(origin, { headers: { host: "evil.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    }).once("error", reject);
  });

const rejectedUpgrade = (url: string, origin?: string) =>
  new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, origin ? { origin } : undefined);
    socket.on("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode!);
      socket.close();
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("An untrusted control upgrade was accepted"));
    });
  });

it.effect("serves the standalone shell while rejecting foreign Hosts and escaping symlinks", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const shell = `${root}/web`;
    yield* fs.makeDirectory(shell);
    yield* fs.writeFileString(
      `${shell}/index.html`,
      "<html><head></head><body>client</body></html>",
    );
    yield* fs.writeFileString(`${shell}/app.js`, "console.log('client')");
    yield* fs.writeFileString(`${root}/secret`, "private");
    yield* fs.symlink(`${root}/secret`, `${shell}/escape`);
    const services = yield* Layer.build(
      HttpRouter.serve(layer(shell), { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provide(platform),
        Layer.provide(Layer.mock(RelayCompanion, {})),
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    );
    const client = Context.get(services, HttpClient.HttpClient);
    const response = yield* client.get("/settings/connections");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(yield* response.text).toContain('name="supacode-relay-companion"');
    expect((yield* client.get("/app.js")).status).toBe(200);
    expect((yield* client.get("/escape")).status).toBe(404);
    const server = Context.get(services, HttpServer.HttpServer);
    expect(
      yield* Effect.promise(() => foreignHostStatus(HttpServer.formatAddress(server.address))),
    ).toBe(421);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["ready", "preparing-close", "preparing-terminate", "preparing-overflow"] as const)(
  "requires the companion origin and releases a tab's leases on disconnect while %s",
  (state) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const released = yield* Deferred.make<{ address: string; owner: string }>();
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      let owner: string | undefined;
      const service = Layer.mock(RelayCompanion, {
        open: (_address, id) =>
          Effect.gen(function* () {
            owner = id;
            yield* Deferred.succeed(started, undefined);
            if (state !== "ready")
              return yield* Effect.never.pipe(
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              );
            return "http://127.0.0.1:4321";
          }),
        close: (address, owner) =>
          Deferred.succeed(released, { address, owner }).pipe(Effect.asVoid),
      });
      const services = yield* Layer.build(
        HttpRouter.serve(layer(root), { disableListenLog: true, disableLogger: true }).pipe(
          Layer.provide(platform),
          Layer.provide(service),
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      );
      const server = Context.get(services, HttpServer.HttpServer);
      if (!("port" in server.address)) throw new Error("No companion listener");
      const origin = `http://127.0.0.1:${server.address.port}`;
      const url = origin.replace(/^http/, "ws") + "/__relay/control";
      expect(yield* Effect.promise(() => rejectedUpgrade(url))).toBe(403);
      expect(yield* Effect.promise(() => rejectedUpgrade(url, "https://evil.example"))).toBe(403);
      const socket = new WebSocket(url, { origin });
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));
      yield* Effect.promise(() => NodeEvents.EventEmitter.once(socket, "open"));
      const reply = NodeEvents.EventEmitter.once(socket, "message");
      socket.send(JSON.stringify({ id: "1", action: "open", address }));
      yield* Deferred.await(started);
      if (state === "ready") {
        expect(JSON.parse(String((yield* Effect.promise(() => reply))[0]))).toEqual({
          id: "1",
          origin: "http://127.0.0.1:4321",
        });
        socket.close();
      } else if (state === "preparing-close") {
        socket.close();
      } else if (state === "preparing-terminate") {
        socket.terminate();
      } else {
        for (let id = 2; id < RELAY_COMPANION_REQUEST_LIMIT + 3; id++)
          socket.send(JSON.stringify({ id: String(id), action: "open", address }));
      }
      if (state !== "ready") yield* Deferred.await(interrupted);
      expect(yield* Deferred.await(released)).toEqual({ address: identity, owner });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not retain failed opens and drains every lease even if a close fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const released = yield* Deferred.make<void>();
    const secondIdentity = `https://${"33".repeat(16)}.${"44".repeat(16)}.relay.supacode.invalid`;
    const failedIdentity = `https://${"55".repeat(16)}.${"66".repeat(16)}.relay.supacode.invalid`;
    const opened: string[] = [];
    const closed: string[] = [];
    const service = Layer.mock(RelayCompanion, {
      open: (address) =>
        Effect.gen(function* () {
          opened.push(address);
          if (address === failedIdentity)
            return yield* new RelayCompanionError({ operation: "open", cause: "Bind failed" });
          return "http://127.0.0.1:4321";
        }),
      close: (address) =>
        Effect.gen(function* () {
          closed.push(address);
          if (address === identity)
            return yield* new RelayCompanionError({ operation: "close", cause: "Close failed" });
          yield* Deferred.succeed(released, undefined);
        }),
    });
    const services = yield* Layer.build(
      HttpRouter.serve(layer(root), { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provide(platform),
        Layer.provide(service),
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    if (!("port" in server.address)) throw new Error("No companion listener");
    const origin = `http://127.0.0.1:${server.address.port}`;
    const socket = new WebSocket(origin.replace(/^http/, "ws") + "/__relay/control", { origin });
    yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));
    yield* Effect.promise(() => NodeEvents.EventEmitter.once(socket, "open"));
    for (const [id, address] of [
      "https://example.invalid",
      "https://broken.relay.supacode.invalid",
      failedIdentity,
      identity,
      secondIdentity,
    ].entries()) {
      const reply = NodeEvents.EventEmitter.once(socket, "message");
      socket.send(JSON.stringify({ id: String(id), action: "open", address }));
      expect(JSON.parse(String((yield* Effect.promise(() => reply))[0]))).toEqual(
        id < 3
          ? { id: String(id), error: "The relay endpoint could not be prepared." }
          : { id: String(id), origin: "http://127.0.0.1:4321" },
      );
    }
    socket.close();
    yield* Deferred.await(released);
    expect(opened).toEqual([failedIdentity, identity, secondIdentity]);
    expect(closed).toEqual([identity, secondIdentity]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
