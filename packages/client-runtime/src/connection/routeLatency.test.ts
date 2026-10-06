import { EnvironmentId } from "@supacode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import { BearerConnectionProfile, type ConnectionRoute } from "./catalog.ts";
import { ROUTE_CHECK_TIMEOUT_MS } from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import { measureConnectionRouteLatency } from "./routeLatency.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";

const environmentId = EnvironmentId.make("latency-test");
const httpBaseUrl = "http://192.168.1.2:4389/";
const directRoute: ConnectionRoute = {
  target: new BearerConnectionTarget({ environmentId, connectionId: "lan", label: "Test" }),
  profile: Option.some(
    new BearerConnectionProfile({
      environmentId,
      connectionId: "lan",
      label: "Test",
      httpBaseUrl,
      wsBaseUrl: "ws://192.168.1.2:4389/",
    }),
  ),
};
const sshRoute: ConnectionRoute = {
  target: new SshConnectionTarget({ environmentId, connectionId: "ssh", label: "Test" }),
  profile: Option.none(),
};
const descriptor = {
  environmentId,
  label: "Test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

describe("route latency", () => {
  it.effect("measures a response from the expected environment", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const response = yield* Deferred.make<Response>();
      const client = HttpClient.make((request) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(response)),
          Effect.map((reply) => HttpClientResponse.fromWeb(request, reply)),
        ),
      );
      const fiber = yield* measureConnectionRouteLatency({ route: directRoute }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(37);
      yield* Deferred.succeed(response, Response.json(descriptor));
      expect(yield* Fiber.join(fiber)).toEqual({ status: "reachable", latencyMs: 37 });
    }),
  );

  it.effect("bypasses cached responses and sends no credential", () =>
    Effect.gen(function* () {
      const calls: RequestInit[] = [];
      const fetchFn: typeof fetch = async (_request, init) => {
        calls.push(init ?? {});
        return Response.json(descriptor);
      };
      const result = yield* measureConnectionRouteLatency({ route: directRoute }).pipe(
        Effect.provide(layerRemoteHttpClient(fetchFn)),
      );
      expect(result.status).toBe("reachable");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.cache).toBe("no-store");
      expect(calls[0]?.credentials).toBe("omit");
      expect(new Headers(calls[0]?.headers).has("authorization")).toBe(false);
    }),
  );

  it.effect("measures the primary route without a saved profile", () =>
    Effect.gen(function* () {
      const primary: ConnectionRoute = {
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Local",
          httpBaseUrl: "http://localhost:4389/",
          wsBaseUrl: "ws://localhost:4389/",
        }),
        profile: Option.none(),
      };
      const result = yield* measureConnectionRouteLatency({ route: primary }).pipe(
        Effect.provide(layerRemoteHttpClient(async () => Response.json(descriptor))),
      );
      expect(result.status).toBe("reachable");
    }),
  );

  it.effect.each([
    {
      name: "a different environment",
      reply: () => Response.json({ ...descriptor, environmentId: "another" }),
    },
    { name: "an invalid descriptor", reply: () => Response.json({}) },
    { name: "an HTTP failure", reply: () => new Response(null, { status: 503 }) },
    {
      name: "a network failure",
      reply: () => Promise.reject(new TypeError("Network request failed")),
    },
  ])("marks $name unreachable", ({ reply }) =>
    measureConnectionRouteLatency({ route: directRoute }).pipe(
      Effect.provide(layerRemoteHttpClient(async () => reply())),
      Effect.tap((result) => Effect.sync(() => expect(result).toEqual({ status: "unreachable" }))),
    ),
  );

  it.effect("times out and cancels a silent route", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const client = HttpClient.make(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
        ),
      );
      const fiber = yield* measureConnectionRouteLatency({ route: directRoute }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(ROUTE_CHECK_TIMEOUT_MS);
      expect(yield* Fiber.join(fiber)).toEqual({ status: "unreachable" });
      yield* Deferred.await(cancelled);
    }),
  );

  it.effect("leaves SSH unmeasured without an active session", () =>
    measureConnectionRouteLatency({ route: sshRoute }).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result).toEqual({ status: "unmeasured" }))),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP request")),
      ),
    ),
  );

  it.effect("measures a probe through an active SSH session", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const answered = yield* Deferred.make<void>();
      const fiber = yield* measureConnectionRouteLatency({
        route: sshRoute,
        sshProbe: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(answered)),
        ),
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected HTTP request")),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(24);
      yield* Deferred.succeed(answered, undefined);
      expect(yield* Fiber.join(fiber)).toEqual({ status: "reachable", latencyMs: 24 });
    }),
  );

  it.effect("marks a failed SSH probe unreachable", () =>
    measureConnectionRouteLatency({
      route: sshRoute,
      sshProbe: Effect.fail(
        new ConnectionTransientError({ reason: "transport", detail: "Disconnected" }),
      ),
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP request")),
      ),
      Effect.tap((result) => Effect.sync(() => expect(result).toEqual({ status: "unreachable" }))),
    ),
  );
});
