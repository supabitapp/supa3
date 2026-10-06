import {
  AuthStandardClientScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@supacode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  type ConnectionRegistration,
  type ConnectionRoute,
} from "./catalog.ts";
import * as CredentialStore from "./credentialStore.ts";
import { BearerConnectionTarget } from "./model.ts";
import {
  ConnectionOnboarding,
  layer as layerConnectionOnboarding,
  prepareBearerConnectionUpdate,
  preparePairingRegistration,
  prepareSshRegistration,
} from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { entryWithRoutes } from "./routes.ts";

const layerClientPresentation = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({
    metadata: {
      label: "Supacode Test",
      deviceType: "desktop",
      os: "Test OS",
    },
    scopes: AuthStandardClientScopes,
  }),
);

function layerPairingHttp(
  calls: Array<{ readonly url: string; readonly init: RequestInit }>,
  options?: {
    readonly failDescriptor?: boolean;
    readonly protocolVersion?: number;
    readonly selfUpdate?: boolean;
  },
) {
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/.well-known/supacode/environment")) {
      if (options?.failDescriptor === true) {
        return Promise.resolve(
          Response.json({ message: "descriptor unavailable" }, { status: 503 }),
        );
      }
      return Promise.resolve(descriptorResponse("environment-paired", options));
    }

    if (url.endsWith("/oauth/token")) {
      return Promise.resolve(tokenResponse());
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  return RpcHttp.layerRemoteHttpClient(fetchFn);
}

function descriptorResponse(
  environmentId: string,
  options?: { readonly protocolVersion?: number; readonly selfUpdate?: boolean },
) {
  return Response.json({
    environmentId,
    label: "Paired environment",
    platform: {
      os: "linux",
      arch: "x64",
    },
    serverVersion: "0.0.0-test",
    orchestrationProtocolVersion: options?.protocolVersion ?? ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: {
      repositoryIdentity: true,
      ...(options?.selfUpdate === true ? { serverSelfUpdate: "boot-service" } : {}),
    },
  });
}

function tokenResponse() {
  return Response.json({
    access_token: "bearer-token",
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "Bearer",
    expires_in: 3600,
    scope: AuthStandardClientScopes.join(" "),
  });
}

const SAVED_ENVIRONMENT_ID = EnvironmentId.make("environment-paired");
const LAN = "http://192.168.1.10:3773";
const TAILNET = "https://minim5.tail.ts.net";
const PUBLIC = "https://public.example.test";
const TAILNET_CONNECTION = `bearer:environment-paired:${TAILNET}`;
const PUBLIC_CONNECTION = `bearer:environment-paired:${PUBLIC}`;

function savedRoute(httpBaseUrl: string, connectionId: string, learned?: true): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({
      environmentId: SAVED_ENVIRONMENT_ID,
      label: "minim5",
      connectionId,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId: SAVED_ENVIRONMENT_ID,
        label: "minim5",
        httpBaseUrl: `${httpBaseUrl}/`,
        wsBaseUrl: `${httpBaseUrl.replace(/^http/, "ws")}/`,
        ...(learned ? { learned } : {}),
      }),
    ),
  };
}

/** Paired over Tailscale and a public link; the LAN address was learned later. */
function savedEnvironment(): ConnectionCatalogEntry {
  const tailnet = savedRoute(TAILNET, TAILNET_CONNECTION);
  return entryWithRoutes({ target: tailnet.target, profile: tailnet.profile, enabled: true }, [
    savedRoute(LAN, `learned:environment-paired:${LAN}@${TAILNET_CONNECTION}`, true),
    tailnet,
    savedRoute(PUBLIC, PUBLIC_CONNECTION),
  ]);
}

/**
 * Answers the routes a test lists. A silent route never answers, like a LAN
 * address from cellular; every other address fails at once.
 */
function layerRoutedHttp(
  calls: Array<string>,
  routes: Record<string, "silent" | ((path: string, init: RequestInit) => Response)>,
  silenced?: Deferred.Deferred<void>,
) {
  const fetchFn = ((input, init = {}) => {
    const url = new URL(String(input));
    calls.push(url.href);
    const answer = routes[url.origin];
    if (answer === "silent") {
      if (silenced !== undefined) Deferred.doneUnsafe(silenced, Effect.void);
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    }
    return answer === undefined
      ? Promise.reject(new TypeError("Network request failed"))
      : Promise.resolve(answer(url.pathname, init));
  }) satisfies typeof fetch;
  return RpcHttp.layerRemoteHttpClient(fetchFn);
}

function pairingServer(environmentId = "environment-paired") {
  return (path: string, init: RequestInit) => {
    if (path === "/.well-known/supacode/environment") return descriptorResponse(environmentId);
    if (path === "/oauth/token") return tokenResponse();
    if (path === "/api/auth/session") {
      const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "");
      return Response.json({
        authenticated: token === "bearer-token" || token === "working-token",
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["bearer-access-token"],
          sessionCookieName: "supacode_session",
        },
      });
    }
    return Response.json({ message: "not found" }, { status: 404 });
  };
}

describe("connection onboarding", () => {
  it.effect("prepares a persisted bearer registration from pairing details", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const { registration } = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))));

      expect(registration).toMatchObject({
        _tag: "BearerConnectionRegistration",
        target: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
        },
        profile: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
          httpBaseUrl: "https://remote.example.test/",
          wsBaseUrl: "wss://remote.example.test/",
        },
        credential: {
          token: "bearer-token",
        },
      });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/supacode/environment",
        "https://remote.example.test/oauth/token",
      ]);

      const tokenRequest = calls.find((call) => call.url.endsWith("/oauth/token"));
      const tokenBody =
        tokenRequest?.init.body instanceof Uint8Array
          ? new TextDecoder().decode(tokenRequest.init.body)
          : String(tokenRequest?.init.body);
      const tokenParams = new URLSearchParams(tokenBody);
      expect(tokenParams.get("subject_token")).toBe("pairing-token");
      expect(tokenParams.get("scope")).toBe(AuthStandardClientScopes.join(" "));
      expect(tokenParams.get("client_label")).toBe("Supacode Test");
    }),
  );

  it.effect("rejects an incompatible server without consuming the pairing credential", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerPairingHttp(calls, { protocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 }),
          ),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/supacode/environment",
      ]);
    }),
  );

  it.effect("pairs an outdated server so it can be updated from this client", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const { registration } = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerPairingHttp(calls, {
              protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1,
              selfUpdate: true,
            }),
          ),
        ),
      );
      expect(registration.target.environmentId).toBe("environment-paired");
      expect(calls.map((call) => call.url)).toContain("https://remote.example.test/oauth/token");
    }),
  );

  it.effect("refuses an outdated server that cannot update itself", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerPairingHttp(calls, { protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1 }),
          ),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error).not.toHaveProperty("serverUpdateRequired");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/supacode/environment",
      ]);
    }),
  );

  it.effect("does not consume a pairing credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];

      yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerPairingHttp(calls, { failDescriptor: true }),
          ),
        ),
        Effect.flip,
      );

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/supacode/environment",
      ]);
    }),
  );

  it.effect("rejects invalid pairing details before making a request", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "",
        pairingCode: "",
      }).pipe(
        Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
        message: "Enter a backend URL.",
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("updates bearer metadata while preserving the credential and identity", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const registration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "  Renamed environment  ",
          httpBaseUrl: "http://100.65.180.100:3773/path",
        },
        entry: Option.some({
          target: new BearerConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "bearer:environment-paired:https://remote.example.test",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired:https://remote.example.test",
              environmentId,
              label: "Old label",
              httpBaseUrl: "http://old.example.test/",
              wsBaseUrl: "ws://old.example.test/",
            }),
          ),
          enabled: true,
        }),
        credential: Option.some(new BearerConnectionCredential({ token: "bearer-token" })),
      });

      expect(registration).toMatchObject({
        target: {
          environmentId,
          label: "Renamed environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
        },
        profile: {
          environmentId,
          label: "Renamed environment",
          httpBaseUrl: "http://100.65.180.100:3773/",
          wsBaseUrl: "ws://100.65.180.100:3773/",
        },
        credential: { token: "bearer-token" },
      });
    }),
  );

  it.effect("prepares an SSH registration from the provisioned platform environment", () =>
    Effect.gen(function* () {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      };
      const registration = yield* prepareSshRegistration({
        target,
      }).pipe(
        Effect.provideService(
          ClientCapabilities.SshEnvironmentGateway,
          ClientCapabilities.SshEnvironmentGateway.of({
            provision: () =>
              Effect.succeed({
                environmentId: EnvironmentId.make("environment-ssh"),
                label: "Remote development box",
                bootstrap: {
                  target,
                  httpBaseUrl: "http://127.0.0.1:3201",
                  wsBaseUrl: "ws://127.0.0.1:3201",
                  pairingToken: "pairing-token",
                },
                bearerToken: "bearer-token",
              }),
            prepare: () => Effect.die("unused"),
            disconnect: () => Effect.die("unused"),
          }),
        ),
      );

      expect(registration).toMatchObject({
        _tag: "SshConnectionRegistration",
        target: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
        },
        profile: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
          target,
        },
      });
    }),
  );

  it.effect(
    "pairs a saved environment through another route when the link's address is unreachable",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const { registration, reachedHttpBaseUrl } = yield* preparePairingRegistration(
          { pairingUrl: `${LAN}/#token=pairing-token` },
          [savedEnvironment()],
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerClientPresentation,
              layerRoutedHttp(calls, {
                [TAILNET]: pairingServer(),
                [PUBLIC]: pairingServer("environment-other"),
              }),
            ),
          ),
        );

        expect(reachedHttpBaseUrl).toBe(`${TAILNET}/`);
        expect(registration).toMatchObject({
          target: { connectionId: `bearer:environment-paired:${LAN}` },
          profile: { httpBaseUrl: `${LAN}/`, wsBaseUrl: "ws://192.168.1.10:3773/" },
          credential: { token: "bearer-token" },
        });
        expect(calls).toContain(`${TAILNET}/oauth/token`);
        expect(calls).not.toContain(`${PUBLIC}/oauth/token`);
      }),
  );

  it.effect("pairs through another route once the link's address misses the route check", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const silenced = yield* Deferred.make<void>();
      const fiber = yield* preparePairingRegistration(
        { pairingUrl: `${LAN}/#token=pairing-token` },
        [savedEnvironment()],
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerRoutedHttp(calls, { [LAN]: "silent", [TAILNET]: pairingServer() }, silenced),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(silenced);
      expect(calls).toEqual([`${LAN}/.well-known/supacode/environment`]);

      yield* TestClock.adjust("2500 millis");
      const { reachedHttpBaseUrl } = yield* Fiber.join(fiber);
      expect(reachedHttpBaseUrl).toBe(`${TAILNET}/`);
    }),
  );

  it.effect("pairs on the link's address when it answers", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const { reachedHttpBaseUrl } = yield* preparePairingRegistration(
        { pairingUrl: `${LAN}/#token=pairing-token` },
        [savedEnvironment()],
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerRoutedHttp(calls, { [LAN]: pairingServer(), [TAILNET]: pairingServer() }),
          ),
        ),
      );

      expect(reachedHttpBaseUrl).toBe(`${LAN}/`);
      expect(calls).toEqual([`${LAN}/.well-known/supacode/environment`, `${LAN}/oauth/token`]);
    }),
  );

  it.effect("reports the link's own error when no saved route answers as that machine", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const error = yield* preparePairingRegistration(
        { pairingUrl: `${LAN}/#token=pairing-token` },
        [savedEnvironment()],
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerRoutedHttp(calls, { [TAILNET]: pairingServer("environment-other") }),
          ),
        ),
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "ConnectionTransientError", reason: "network" });
      expect(calls.filter((url) => url.endsWith("/oauth/token"))).toEqual([]);
    }),
  );

  it.effect("re-pairing gives the new credential to saved routes the server rejects", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const stored = new Map<string, ConnectionCredential>([
        [TAILNET_CONNECTION, new BearerConnectionCredential({ token: "revoked-token" })],
        [PUBLIC_CONNECTION, new BearerConnectionCredential({ token: "working-token" })],
      ]);
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map([[SAVED_ENVIRONMENT_ID, savedEnvironment()]]));
      const registry = EnvironmentRegistry.EnvironmentRegistry.of({
        entries,
        register: (registration: ConnectionRegistration) =>
          Effect.sync(() => {
            events.push(`register:${registration.target.connectionId}`);
          }),
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

      const onboarding = yield* ConnectionOnboarding.pipe(
        Effect.provide(
          layerConnectionOnboarding.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
                layerClientPresentation,
                layerRoutedHttp([], { [TAILNET]: pairingServer(), [PUBLIC]: pairingServer() }),
                Layer.succeed(
                  ClientCapabilities.SshEnvironmentGateway,
                  {} as ClientCapabilities.SshEnvironmentGateway["Service"],
                ),
                Layer.succeed(
                  CredentialStore.ConnectionCredentialStore,
                  CredentialStore.make({
                    get: (connectionId) =>
                      Effect.sync(() => Option.fromUndefinedOr(stored.get(connectionId))),
                    put: (connectionId, credential) =>
                      Effect.sync(() => {
                        events.push(`put:${connectionId}`);
                        stored.set(connectionId, credential);
                      }),
                    remove: (connectionId) => Effect.sync(() => stored.delete(connectionId)),
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      yield* onboarding.registerPairing({ pairingUrl: `${LAN}/#token=pairing-token` });

      expect(events).toEqual([
        `put:${TAILNET_CONNECTION}`,
        `register:bearer:environment-paired:${LAN}`,
      ]);
      expect(stored.get(TAILNET_CONNECTION)).toMatchObject({ token: "bearer-token" });
      expect(stored.get(PUBLIC_CONNECTION)).toMatchObject({ token: "working-token" });
    }),
  );
});
