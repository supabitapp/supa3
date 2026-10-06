import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import type {
  ConnectionAttemptError,
  ConnectionAttemptStage,
  PreparedConnection,
} from "./model.ts";
import { ConnectionTransientError } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import { connectionRoutes, routeEntry, routeHttpBaseUrl } from "./routes.ts";
import * as RpcSession from "../rpc/session.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";

export type ConnectionDriverProgress =
  | {
      readonly stage: "preparing";
    }
  | {
      readonly stage: Exclude<ConnectionAttemptStage, "preparing">;
      readonly prepared: PreparedConnection;
    };

export interface EnvironmentConnectionLease {
  readonly prepared: PreparedConnection;
  readonly session: RpcSession.RpcSession;
}

/**
 * The result of an unauthenticated reachability check. SSH routes have no
 * cheap check, so they are "unchecked".
 */
export type RouteCheck = "answered" | "silent" | "unchecked";

/** How long a direct route has to answer before the attempt moves on to the routes after it. */
const ROUTE_CHECK_WINDOW_MS = 2_500;
/** How long a check keeps listening, so a slow route still goes ahead of one that never answers. */
const ROUTE_CHECK_TIMEOUT_MS = 15_000;

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      entry: ConnectionCatalogEntry,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
    ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope>;
    /** Whether a direct route answers as the entry's environment, without credentials. */
    readonly checkRoute: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<RouteCheck>;
    /**
     * Whether a direct route answers and accepts this client's credential,
     * without opening a socket. Switching to a route that fails this would
     * drop a working connection for nothing.
     */
    readonly preflight: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<boolean>;
  }
>()("@supacode/client-runtime/connection/driver/ConnectionDriver") {}

/**
 * Connects over the first route, in preference order, that is worth trying.
 * Every route is checked at once, but a route only waits for its own check,
 * so a reachable LAN address connects without waiting on a silent tailnet
 * one. A route that misses the check window is skipped on the first pass so a
 * LAN address from another network costs one short check, not a connection
 * timeout. A route that fails to connect moves on to the next so an
 * unavailable address cannot hide a working LAN or Tailscale route.
 *
 * Skipped routes are tried in the order their checks answer late, so a tailnet
 * still waking up after a network change goes ahead of a LAN that will never
 * answer. Routes whose checks never answer are tried last, since a check is not
 * proof.
 *
 * The reported error is a transient one when any route failed transiently,
 * so the supervisor keeps retrying a route that may come back; a blocked
 * error is reported only when every attempted route was blocked.
 */
export const connectOverRoutes = Effect.fn("ConnectionDriver.connectOverRoutes")(function* <R>(
  entry: ConnectionCatalogEntry,
  checkRoute: (route: ConnectionRoute) => Effect.Effect<RouteCheck>,
  connectRoute: (
    route: ConnectionRoute,
  ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, R | Scope.Scope>,
) {
  const routes = connectionRoutes(entry);
  const results: Array<RouteCheck | undefined> = routes.map(() => undefined);
  const checks =
    routes.length === 1
      ? []
      : yield* Effect.forEach(routes, (route, index) =>
          Effect.forkChild(
            checkRoute(route).pipe(
              Effect.tap((check) =>
                Effect.sync(() => {
                  results[index] = check;
                }),
              ),
            ),
          ),
        );
  const inWindow = yield* Effect.forEach(checks, (check) =>
    Effect.forkChild(Fiber.join(check).pipe(Effect.timeoutOption(ROUTE_CHECK_WINDOW_MS))),
  );
  const attemptScope = yield* Scope.Scope;
  let transient: ConnectionAttemptError | undefined;
  let blocked: ConnectionAttemptError | undefined;
  // Each route gets its own scope so a half-open session closes before the next try.
  const attempt = Effect.fnUntraced(function* (route: ConnectionRoute) {
    const routeScope = yield* Scope.fork(attemptScope);
    const result = yield* connectRoute(route).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(
            new ConnectionTransientError({
              reason: "timeout",
              detail: `${route.target.label} did not respond during connection setup.`,
            }),
          ),
      }),
      Scope.provide(routeScope),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(routeScope, exit))),
      Effect.result,
    );
    if (result._tag === "Failure") {
      if (result.failure._tag === "ConnectionTransientError") transient ??= result.failure;
      else blocked ??= result.failure;
    }
    return result;
  });
  let skipped: Array<number> = [];
  for (const [index, route] of routes.entries()) {
    const check =
      inWindow.length === 0 ? Option.some("unchecked") : yield* Fiber.join(inWindow[index]!);
    if (Option.isNone(check) || check.value === "silent") {
      skipped.push(index);
      continue;
    }
    const result = yield* attempt(route);
    if (result._tag === "Success") return result.success;
    // An incompatible server is the same server on every route.
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  while (skipped.length > 0) {
    const answered = skipped.find(
      (index) => results[index] !== undefined && results[index] !== "silent",
    );
    const pending = skipped.filter((index) => results[index] === undefined);
    if (answered === undefined && pending.length > 0) {
      yield* Effect.raceAll(pending.map((index) => Fiber.await(checks[index]!)));
      continue;
    }
    const index = answered ?? skipped[0]!;
    skipped = skipped.filter((candidate) => candidate !== index);
    const result = yield* attempt(routes[index]!);
    if (result._tag === "Success") return result.success;
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  return yield* (
    transient ??
      blocked ??
      new ConnectionTransientError({
        reason: "endpoint-unavailable",
        detail: `${entry.target.label} did not answer on any saved route.`,
      })
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;
  const httpClient = yield* HttpClient.HttpClient;

  const checkRoute = (
    entry: ConnectionCatalogEntry,
    route: ConnectionRoute,
    timeoutMs = ROUTE_CHECK_WINDOW_MS,
  ) => {
    const httpBaseUrl = routeHttpBaseUrl(route);
    if (httpBaseUrl === null) return Effect.succeed<RouteCheck>("unchecked");
    // The descriptor is public, so this sends no credential to whatever
    // answers at a saved LAN address on a different network.
    return fetchRemoteEnvironmentDescriptor({
      httpBaseUrl,
      timeoutMs,
    }).pipe(
      Effect.map((descriptor): RouteCheck =>
        descriptor.environmentId === entry.target.environmentId ? "answered" : "silent",
      ),
      Effect.orElseSucceed((): RouteCheck => "silent"),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.withSpan("ConnectionDriver.checkRoute", {
        attributes: { "connection.target.kind": route.target._tag },
      }),
    );
  };

  const connect = Effect.fn("ConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const target = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
      "connection.route.count": connectionRoutes(entry).length,
    });
    yield* reportProgress({ stage: "preparing" });
    return yield* connectOverRoutes(
      entry,
      (route) => checkRoute(entry, route, ROUTE_CHECK_TIMEOUT_MS),
      Effect.fnUntraced(function* (route) {
        const prepared = yield* resolver.prepare(routeEntry(entry, route));
        yield* reportProgress({ stage: "opening", prepared });
        const session = yield* sessions.connect(prepared);
        yield* reportProgress({ stage: "synchronizing", prepared });
        yield* session.ready;
        return { prepared, session } satisfies EnvironmentConnectionLease;
      }),
    );
  });

  const preflight = (entry: ConnectionCatalogEntry, route: ConnectionRoute) =>
    checkRoute(entry, route).pipe(
      Effect.flatMap((check) =>
        check === "answered"
          ? resolver.prepare(routeEntry(entry, route)).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false),
      ),
      Effect.withSpan("ConnectionDriver.preflight"),
    );

  return ConnectionDriver.of({ connect, checkRoute, preflight });
});

export const layer = Layer.effect(ConnectionDriver, make);
