import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@supacode/contracts";
import { resolveRemotePairingTarget } from "@supacode/shared/remote";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import { bootstrapRemoteBearerSession, fetchRemoteSessionState } from "../authorization/remote.ts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { ROUTE_CHECK_TIMEOUT_MS } from "./driver.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import {
  connectionRoutes,
  credentialConnectionId,
  isLearned,
  pairingFallbackRoutes,
  routeEntry,
  sshTargetKey,
} from "./routes.ts";

export interface PairingConnectionInput {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
  /** When set, the pairing must resolve to an existing environment route. */
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface SshConnectionInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface BearerConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

export class ConnectionOnboarding extends Context.Service<
  ConnectionOnboarding,
  {
    readonly registerPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly registerSsh: (
      input: SshConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
  }
>()("@supacode/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    return yield* Effect.try({
      try: () => resolveRemotePairingTarget(input),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: cause instanceof Error ? cause.message : "The pairing details are invalid.",
        }),
    });
  },
);

function bearerConnectionId(environmentId: EnvironmentId, httpBaseUrl: string): string {
  return `bearer:${environmentId}:${new URL(httpBaseUrl).origin}`;
}

function differentMachineError(label: string) {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `That address reaches ${label}, a different machine. Add it as its own environment instead.`,
  });
}

/**
 * Reaches the server behind a pairing link. When the link's address belongs to
 * a saved environment, that environment's other routes are tried once the
 * address misses the route check, so a LAN link still pairs over Tailscale.
 */
const reachPairingServer = Effect.fn("clientRuntime.connection.onboarding.reachPairingServer")(
  function* (httpBaseUrl: string, saved: ReadonlyArray<ConnectionCatalogEntry>) {
    const reach = (url: string) =>
      fetchRemoteEnvironmentDescriptor({ httpBaseUrl: url }).pipe(
        Effect.map((descriptor) => ({ httpBaseUrl: url, descriptor })),
      );
    const linkedAddress = reach(httpBaseUrl).pipe(Effect.mapError(mapRemoteEnvironmentError));
    const fallback = pairingFallbackRoutes(saved, httpBaseUrl);
    if (fallback === null) return yield* linkedAddress;
    const linked = yield* Effect.forkChild(linkedAddress);
    const savedRoutes = Effect.raceAll(
      fallback.httpBaseUrls.map((url) =>
        reach(url).pipe(
          Effect.filterOrFail(
            (reached) => reached.descriptor.environmentId === fallback.environmentId,
          ),
        ),
      ),
    );
    const early = yield* Fiber.await(linked).pipe(Effect.timeoutOption(ROUTE_CHECK_TIMEOUT_MS));
    if (Option.isSome(early) && Exit.isSuccess(early.value)) return early.value.value;
    return yield* Effect.raceAll([Fiber.join(linked), savedRoutes]).pipe(
      Effect.catch(() => Fiber.join(linked)),
    );
  },
);

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput, saved: ReadonlyArray<ConnectionCatalogEntry> = []) {
  const target = yield* resolvePairingTarget(input);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const expected = input.expectedEnvironmentId;
  const { httpBaseUrl: reachedHttpBaseUrl, descriptor } = yield* reachPairingServer(
    target.httpBaseUrl,
    expected === undefined
      ? saved
      : saved.filter((entry) => entry.target.environmentId === expected),
  );
  if (expected !== undefined && descriptor.environmentId !== expected) {
    return yield* differentMachineError(descriptor.label);
  }
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  // An outdated server is still saved so it can be updated from this client.
  if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
    return yield* compatibilityError;
  }
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: reachedHttpBaseUrl,
    credential: target.credential,
    scopes: presentation.scopes,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const connectionId = bearerConnectionId(descriptor.environmentId, target.httpBaseUrl);

  const registration = new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
    }),
    credential: new BearerConnectionCredential({
      token: access.access_token,
    }),
  });
  return { registration, reachedHttpBaseUrl };
});

const isBearerCredential = Schema.is(BearerConnectionCredential);

/**
 * Each route of a saved environment keeps the credential it was paired with,
 * so re-pairing after a revoked session would otherwise fix only the linked
 * address. Credentials the server no longer accepts take the new one.
 */
const replaceRejectedCredentials = Effect.fn(
  "clientRuntime.connection.onboarding.replaceRejectedCredentials",
)(function* (
  entry: ConnectionCatalogEntry,
  registration: BearerConnectionRegistration,
  httpBaseUrl: string,
) {
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const connectionIds = new Set(
    connectionRoutes(entry).flatMap((route) =>
      route.target._tag === "BearerConnectionTarget"
        ? [credentialConnectionId(route.target.connectionId)]
        : [],
    ),
  );
  connectionIds.delete(registration.target.connectionId);
  yield* Effect.forEach(
    connectionIds,
    (connectionId) =>
      Effect.gen(function* () {
        const saved = Option.getOrUndefined(yield* credentials.get(connectionId));
        if (saved !== undefined && isBearerCredential(saved)) {
          const session = yield* fetchRemoteSessionState({ httpBaseUrl, bearerToken: saved.token });
          if (session.authenticated) return;
        }
        yield* credentials.put(connectionId, registration.credential);
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not refresh a saved credential.", { connectionId, error }),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  );
});

const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const saved = yield* SubscriptionRef.get(registry.entries);
  const { registration, reachedHttpBaseUrl } = yield* preparePairingRegistration(input, [
    ...saved.values(),
  ]);
  const previous = saved.get(registration.target.environmentId);
  if (previous !== undefined) {
    yield* replaceRejectedCredentials(previous, registration, reachedHttpBaseUrl);
  }
  yield* registry.register(registration);
  return registration.target.environmentId;
});

const isBearerProfile = Schema.is(BearerConnectionProfile);

const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const saved = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  const route =
    saved === undefined
      ? undefined
      : connectionRoutes(saved).find(
          (candidate) =>
            candidate.target._tag === "BearerConnectionTarget" && !isLearned(candidate),
        );
  const entry = saved === undefined || route === undefined ? saved : routeEntry(saved, route);
  const credential =
    entry?.target._tag === "BearerConnectionTarget"
      ? yield* credentials.get(entry.target.connectionId)
      : Option.none();
  const registration = yield* prepareBearerConnectionUpdate({
    input,
    entry: Option.fromUndefinedOr(entry),
    credential,
  });
  yield* registry.register(registration);
});

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === undefined ||
    entry === null ||
    entry.target._tag !== "BearerConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isBearerProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved bearer environments can be edited.",
    });
  }

  const credential = options.credential;
  if (Option.isNone(credential) || !isBearerCredential(credential.value)) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The saved bearer credential is unavailable.",
    });
  }

  const label = options.input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Environment label cannot be empty.",
    });
  }
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(options.input.httpBaseUrl),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "The environment URL is invalid.",
      }),
  });
  const connectionId = entry.target.connectionId;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    }),
    credential: credential.value,
  });
});

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
  const provisioned = yield* gateway.provision(input.target, input.expectedEnvironmentId);
  if (
    input.expectedEnvironmentId !== undefined &&
    provisioned.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "The SSH target belongs to a different environment.",
    });
  }
  const connectionId = `ssh:${provisioned.environmentId}:${sshTargetKey(provisioned.bootstrap.target)}`;
  const label = input.label?.trim() || provisioned.label || provisioned.bootstrap.target.alias;

  return new SshConnectionRegistration({
    target: new SshConnectionTarget({
      environmentId: provisioned.environmentId,
      label,
      connectionId,
    }),
    profile: new SshConnectionProfile({
      connectionId,
      environmentId: provisioned.environmentId,
      label,
      target: provisioned.bootstrap.target,
    }),
  });
});

const registerSshConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSshConnection",
)(function* (input: SshConnectionInput) {
  const registration = yield* prepareSshRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;

  return ConnectionOnboarding.of({
    registerPairing: (input) =>
      registerPairingConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
      ),
    registerSsh: (input) =>
      registerSshConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
      ),
    updateBearer: (input) =>
      updateBearerConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
      ),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);
