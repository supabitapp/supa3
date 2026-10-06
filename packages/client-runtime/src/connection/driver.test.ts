import { EnvironmentId } from "@supacode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { BearerConnectionProfile, type ConnectionRoute } from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
} from "./model.ts";
import { connectOverRoutes, type EnvironmentConnectionLease } from "./driver.ts";

function route(id: string, host: string): ConnectionRoute {
  const target = new BearerConnectionTarget({
    connectionId: id,
    environmentId: EnvironmentId.make("test"),
    label: "Test",
  });
  return {
    target,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: `http://${host}/`,
        wsBaseUrl: `ws://${host}/`,
      }),
    ),
  };
}
const lan = route("lan", "192.168.1.2:4389");
const tailnet = route("tailnet", "100.100.1.2:4389");
const entry = { ...lan, enabled: true, alternateRoutes: [tailnet] };
const lease = (route: ConnectionRoute) =>
  ({ prepared: { target: route.target } }) as EnvironmentConnectionLease;
const blocked = () =>
  new ConnectionBlockedError({ reason: "authentication", detail: "Token revoked" });
const transient = () =>
  new ConnectionTransientError({ reason: "transport", detail: "Network lost" });

describe("direct route connection attempts", () => {
  it.effect("skips an unreachable LAN and opens the reachable Tailscale route", () =>
    Effect.gen(function* () {
      const attempted: ConnectionRoute[] = [];
      const result = yield* connectOverRoutes(
        entry,
        (route) => Effect.succeed(route === tailnet ? "answered" : "silent"),
        (route) =>
          Effect.sync(() => {
            attempted.push(route);
            return lease(route);
          }),
      );
      expect(result.prepared.target).toEqual(tailnet.target);
      expect(attempted).toEqual([tailnet]);
    }),
  );

  it.effect("does not wait for a fallback probe after LAN connects", () =>
    Effect.gen(function* () {
      const result = yield* connectOverRoutes(
        entry,
        (route) => (route.target === lan.target ? Effect.succeed("answered") : Effect.never),
        (route) => Effect.succeed(lease(route)),
      );
      expect(result.prepared.target).toEqual(lan.target);
    }),
  );

  it.effect("closes failed route resources before trying the next route", () =>
    Effect.gen(function* () {
      const lifecycle: string[] = [];
      const result = yield* connectOverRoutes(
        entry,
        () => Effect.succeed("answered"),
        (route) =>
          Effect.gen(function* () {
            if (route.target === lan.target) {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  lifecycle.push("closed LAN");
                }),
              );
              return yield* blocked();
            }
            lifecycle.push("opened Tailscale");
            return lease(route);
          }),
      );
      expect(result.prepared.target).toEqual(tailnet.target);
      expect(lifecycle).toEqual(["closed LAN", "opened Tailscale"]);
    }),
  );

  it.effect("times out a stalled LAN setup and still reaches Tailscale", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const fiber = yield* connectOverRoutes(
        entry,
        () => Effect.succeed("answered"),
        (route) =>
          route.target === lan.target
            ? Effect.addFinalizer(() => Deferred.succeed(released, undefined)).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.never),
              )
            : Effect.succeed(lease(route)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("15 seconds");
      expect((yield* Fiber.join(fiber)).prepared.target).toEqual(tailnet.target);
      yield* Deferred.await(released);
    }),
  );

  it.effect("tries a route that answers late before one that never answers", () =>
    Effect.gen(function* () {
      const attempted: ConnectionRoute[] = [];
      const checking = yield* Deferred.make<void>();
      const fiber = yield* connectOverRoutes(
        entry,
        (route) =>
          route === tailnet
            ? Effect.sleep("5 seconds").pipe(Effect.as("answered" as const))
            : Deferred.succeed(checking, undefined).pipe(Effect.andThen(Effect.never)),
        (route) =>
          Effect.sync(() => {
            attempted.push(route);
            return lease(route);
          }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(checking);
      yield* TestClock.adjust("5 seconds");
      expect((yield* Fiber.join(fiber)).prepared.target).toEqual(tailnet.target);
      expect(attempted).toEqual([tailnet]);
    }),
  );

  it.effect("retries silent routes after reachable routes reject authentication", () =>
    Effect.gen(function* () {
      const result = yield* connectOverRoutes(
        entry,
        (route) => Effect.succeed(route.target === lan.target ? "silent" : "answered"),
        (route) =>
          route.target === lan.target ? Effect.succeed(lease(route)) : Effect.fail(blocked()),
      );
      expect(result.prepared.target).toEqual(lan.target);
    }),
  );

  it.effect("reports transient failure when one path can recover", () =>
    Effect.gen(function* () {
      const result = yield* connectOverRoutes(
        entry,
        () => Effect.succeed("answered"),
        (route) => Effect.fail(route.target === lan.target ? transient() : blocked()),
      ).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionTransientError" },
      });
    }),
  );

  it.effect("keeps retrying when only a route that never answered is blocked", () =>
    Effect.gen(function* () {
      const result = yield* connectOverRoutes(
        entry,
        () => Effect.succeed("silent"),
        (route) => Effect.fail(route.target === lan.target ? blocked() : transient()),
      ).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionTransientError" },
      });
    }),
  );

  it.effect("keeps retrying a route that answered its check late", () =>
    Effect.gen(function* () {
      const checking = yield* Deferred.make<void>();
      const fiber = yield* connectOverRoutes(
        entry,
        (route) =>
          route.target === lan.target
            ? Deferred.succeed(checking, undefined).pipe(
                Effect.andThen(Effect.sleep("5 seconds")),
                Effect.as("answered" as const),
              )
            : Effect.succeed("answered"),
        (route) => Effect.fail(route.target === lan.target ? transient() : blocked()),
      ).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(checking);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionTransientError" },
      });
    }),
  );

  it.effect("reports a revoked credential instead of an unreachable LAN", () =>
    Effect.gen(function* () {
      const result = yield* connectOverRoutes(
        entry,
        (route) => Effect.succeed(route.target === lan.target ? "silent" : "answered"),
        (route) => Effect.fail(route.target === lan.target ? transient() : blocked()),
      ).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionBlockedError", reason: "authentication" },
      });
    }),
  );
});
