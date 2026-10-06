import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Clock from "effect/Clock";
import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessEnvironment,
} from "@supacode/shared/hostProcess";
import {
  ExecutionEnvironmentDescriptor,
  SelfHostedRemoteAccessError,
  type SelfHostedRemoteAccessConfigureInput,
  type SelfHostedRemoteAccessStatus,
} from "@supacode/contracts";
import {
  RelayManagedEndpoint,
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@supacode/contracts/relay";
import type * as Provisioner from "@supacode/relay/provisioner";
import * as RelayClient from "@supacode/shared/relayClient";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpServer } from "effect/http";

import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Activation from "../serverActivation.ts";
import * as Credentials from "./CloudflareCredentials.ts";
import * as Runtime from "./ManagedEndpointRuntime.ts";

const isRemoteAccessError = Schema.is(SelfHostedRemoteAccessError);
const encodeCommandArgv = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const INSTALLATION_SECRET = "self-hosted-connect-v1";
const Installation = Schema.Struct({
  version: Schema.Literal(1),
  installationId: Schema.String,
  environmentId: Schema.String,
  accountId: Schema.String,
  zoneId: Schema.String,
  zoneName: Schema.String,
  certificatePath: Schema.String,
  enabled: Schema.Boolean,
  removalPending: Schema.Boolean,
  endpoint: Schema.NullOr(RelayManagedEndpoint),
  runtime: Schema.NullOr(RelayManagedEndpointRuntimeConfig),
  origin: Schema.NullOr(RelayManagedEndpointOrigin),
});
type Installation = typeof Installation.Type;
const installationJson = Schema.fromJsonString(Installation);
const Zone = Schema.Struct({ name: Schema.String, account: Schema.Struct({ id: Schema.String }) });

export class SelfHostedEndpoint extends Context.Service<
  SelfHostedEndpoint,
  {
    readonly getStatus: Effect.Effect<SelfHostedRemoteAccessStatus>;
    readonly setup: Effect.Effect<{ readonly prompt: string }>;
    readonly configure: (
      input: SelfHostedRemoteAccessConfigureInput,
    ) => Effect.Effect<SelfHostedRemoteAccessStatus, SelfHostedRemoteAccessError>;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<SelfHostedRemoteAccessStatus, SelfHostedRemoteAccessError>;
    readonly repair: Effect.Effect<SelfHostedRemoteAccessStatus, SelfHostedRemoteAccessError>;
    readonly remove: Effect.Effect<SelfHostedRemoteAccessStatus, SelfHostedRemoteAccessError>;
    readonly initialize: Effect.Effect<void>;
    readonly publicEndpoint: Effect.Effect<string | null>;
    readonly publicEndpointChanges: Stream.Stream<string | null>;
  }
>()("supacode/cloud/SelfHostedEndpoint") {}

function loginFailure(cause: unknown): boolean {
  if (!Predicate.isObject(cause)) return false;
  if (!("_tag" in cause)) return "cause" in cause && loginFailure(cause.cause);
  return (
    cause._tag === "CloudflareLoginRequired" ||
    (cause._tag === "CloudflareApiError" &&
      "status" in cause &&
      (cause.status === 401 || cause.status === 403)) ||
    ("cause" in cause && loginFailure(cause.cause))
  );
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* SecretStore.ServerSecretStore;
  const environment = yield* Environment.ServerEnvironment;
  const runtime = yield* Runtime.CloudManagedEndpointRuntime;
  const relayClient = yield* RelayClient.RelayClient;
  const credentials = yield* Credentials.CloudflareCredentials;
  const http = yield* HttpClient.HttpClient;
  const server = yield* HttpServer.HttpServer;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const relayMode = yield* Config.Boolean("SUPACODE_CONNECT_RELAY_ENABLED").pipe(
    Config.withDefault(false),
  );
  const lock = yield* Semaphore.make(1);
  const environmentId = yield* environment.getEnvironmentId;
  const directory = path.join(config.stateDir, "remote-access");
  const databasePath = path.join(directory, "allocations.sqlite");
  let installation: Installation | null = null;
  let state: SelfHostedRemoteAccessStatus["state"] = relayMode ? "relay-mode" : "unconfigured";
  let failure: SelfHostedRemoteAccessStatus["failure"] = null;
  let ready = false;
  const publishedEndpoint = yield* SubscriptionRef.make<string | null>(null);
  const publishEndpoint = Effect.gen(function* () {
    const next =
      ready && installation?.enabled && !installation.removalPending
        ? (installation.endpoint?.httpBaseUrl ?? null)
        : null;
    if ((yield* SubscriptionRef.get(publishedEndpoint)) !== next)
      yield* SubscriptionRef.set(publishedEndpoint, next);
  });

  const read = secrets.get(INSTALLATION_SECRET).pipe(
    Effect.flatMap((bytes) =>
      Option.isNone(bytes)
        ? Effect.succeed(null)
        : Schema.decodeUnknownEffect(installationJson)(new TextDecoder().decode(bytes.value)),
    ),
    Effect.mapError(() => new SelfHostedRemoteAccessError({ reason: "operation-failed" })),
  );
  installation = yield* read.pipe(
    Effect.catch(() => {
      state = "error";
      failure = "provision-failed";
      return Effect.succeed(null);
    }),
  );
  if (installation !== null && !relayMode)
    state = installation.removalPending
      ? "cleanup-pending"
      : installation.enabled
        ? "connecting"
        : "disabled";

  const status = Effect.sync(() => ({
    state,
    failure,
    ready,
    enabled: installation?.enabled ?? false,
    publicUrl: installation?.endpoint?.httpBaseUrl ?? null,
    accountId: installation?.accountId ?? null,
    zoneName: installation?.zoneName ?? null,
  }));
  const save = Effect.fnUntraced(function* (next: Installation) {
    const json = yield* Schema.encodeEffect(installationJson)(next).pipe(
      Effect.mapError(() => new SelfHostedRemoteAccessError({ reason: "operation-failed" })),
    );
    yield* secrets
      .set(INSTALLATION_SECRET, new TextEncoder().encode(json))
      .pipe(Effect.mapError(() => new SelfHostedRemoteAccessError({ reason: "operation-failed" })));
    installation = next;
  });
  const origin = () => ({
    localHttpHost:
      config.host === "::1" || config.host === "::"
        ? "::1"
        : config.host === "0.0.0.0" || config.host === "localhost"
          ? "127.0.0.1"
          : (config.host ?? "127.0.0.1"),
    localHttpPort: "port" in server.address ? server.address.port : config.port,
  });
  const validateOrigin = Effect.suspend(() =>
    ["127.0.0.1", "::1", "localhost"].includes(origin().localHttpHost)
      ? Effect.void
      : new SelfHostedRemoteAccessError({ reason: "unsupported-binding" }),
  );
  const sameOrigin = (saved: Installation) =>
    saved.origin?.localHttpHost === origin().localHttpHost &&
    saved.origin?.localHttpPort === origin().localHttpPort;
  const guard = Effect.gen(function* () {
    if (relayMode) return yield* new SelfHostedRemoteAccessError({ reason: "relay-mode" });
    const saved = yield* read;
    if (saved !== null && saved.environmentId !== environmentId)
      return yield* new SelfHostedRemoteAccessError({ reason: "account-mismatch" });
    return saved;
  });

  const api = Effect.fnUntraced(function* (certificatePath?: string) {
    const login = yield* credentials.read(certificatePath);
    // Load the infrastructure graph only for explicit management operations.
    const provisioner = yield* Effect.promise(() => import("@supacode/relay/provisioner"));
    const zone = yield* provisioner.CloudflareApi.pipe(
      Effect.flatMap((client) =>
        client.request("GET", `/zones/${encodeURIComponent(login.zoneId)}`, Zone),
      ),
      Effect.provide(provisioner.layerApi(login.token)),
      Effect.provideService(HttpClient.HttpClient, http),
    );
    if (zone.account.id !== login.accountId)
      return yield* new SelfHostedRemoteAccessError({ reason: "account-mismatch" });
    return { login, zone, provisioner };
  });

  const withProvider = Effect.fnUntraced(function* <A, E>(
    saved: Installation,
    operation: (
      provider: Provisioner.ManagedEndpointProvider["Service"],
    ) => Effect.Effect<A, E, Provisioner.LocalRemoval>,
  ) {
    const { login, zone, provisioner } = yield* api(saved.certificatePath);
    if (
      login.accountId !== saved.accountId ||
      login.zoneId !== saved.zoneId ||
      zone.name !== saved.zoneName
    )
      return yield* new SelfHostedRemoteAccessError({ reason: "account-mismatch" });
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.chmod(directory, 0o700);
    return yield* provisioner.ManagedEndpointProvider.pipe(
      Effect.flatMap(operation),
      Effect.provide(
        provisioner.layer({
          ...saved,
          ownerId: `${saved.accountId}:${saved.installationId}`,
          databasePath,
          token: login.token,
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(Crypto.Crypto, crypto),
    );
  });

  const probe = Effect.gen(function* () {
    const saved = installation;
    if (
      relayMode ||
      saved === null ||
      !saved.enabled ||
      saved.removalPending ||
      saved.endpoint === null ||
      !sameOrigin(saved)
    )
      return;
    const matches = yield* http
      .get(new URL("/.well-known/supacode/environment", saved.endpoint.httpBaseUrl).toString())
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
        Effect.map((descriptor) => descriptor.environmentId === environmentId),
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => false),
      );
    if (installation !== saved || !saved.enabled) return;
    ready = matches;
    yield* publishEndpoint;
    if (matches && state !== "needs-login") {
      state = "connected";
      failure = null;
    } else if (!matches && state === "connected") {
      state = "connecting";
      failure = "endpoint-unavailable";
    }
  });

  const failed = (cause: unknown) => {
    const login = loginFailure(cause);
    state = installation?.removalPending ? "cleanup-pending" : login ? "needs-login" : "error";
    failure = installation?.removalPending
      ? "cleanup-failed"
      : login
        ? "login-required"
        : "provision-failed";
    return Effect.fail(
      isRemoteAccessError(cause)
        ? cause
        : new SelfHostedRemoteAccessError({
            reason: login ? "login-required" : "operation-failed",
          }),
    );
  };

  const start = Effect.fnUntraced(function* (saved: Installation) {
    if (!saved.enabled || saved.runtime === null) {
      state = "disabled";
      return;
    }
    yield* relayClient.install;
    const result = yield* runtime.applyConfig(saved.runtime);
    if (result.status !== "running")
      return yield* new SelfHostedRemoteAccessError({ reason: "operation-failed" });
    state = "connecting";
    failure = null;
    yield* probe;
  });

  const repair = Effect.gen(function* () {
    const saved = yield* guard;
    if (saved === null) return yield* new SelfHostedRemoteAccessError({ reason: "not-configured" });
    if (saved.removalPending)
      return yield* new SelfHostedRemoteAccessError({ reason: "cleanup-pending" });
    yield* validateOrigin;
    state = "connecting";
    const result = yield* withProvider(saved, (provider) =>
      provider.provision({
        userId: `${saved.accountId}:${saved.installationId}`,
        environmentId,
        origin: origin(),
      }),
    );
    const next = { ...saved, endpoint: result.endpoint, runtime: result.runtime, origin: origin() };
    yield* save(next);
    yield* start(next);
    return yield* status;
  }).pipe(Effect.catch(failed));

  if (!relayMode) {
    let lastRecovery = 0;
    yield* runtime.tunnelConnected.pipe(
      Stream.runForEach(() => probe),
      Effect.forkScoped,
    );
    yield* runtime.recoveryRequests.pipe(
      Stream.runForEach((request) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const remaining = 120_000 - (now - lastRecovery);
          if (remaining > 0) yield* Effect.sleep(remaining);
          lastRecovery = yield* Clock.currentTimeMillis;
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (
                relayMode ||
                !installation?.enabled ||
                installation.removalPending ||
                installation.runtime?.tunnelId !== request.tunnelId
              )
                return;
              yield* repair.pipe(Effect.ignore);
            }),
          );
        }),
      ),
      Effect.forkScoped,
    );
  }

  const initialize = Effect.gen(function* () {
    if (relayMode) return;
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (installation === null || !installation.enabled || installation.removalPending) return;
        if (installation.runtime !== null && sameOrigin(installation))
          yield* start(installation).pipe(Effect.catch(failed), Effect.ignore);
        else yield* repair.pipe(Effect.ignore);
      }),
    );
    yield* probe;
  });
  if (!relayMode)
    yield* Activation.forkParked(
      initialize.pipe(Effect.andThen(probe.pipe(Effect.repeat(Schedule.spaced("15 seconds"))))),
    );

  const processArgs = yield* HostProcessArguments;
  const executable = yield* HostProcessExecutablePath;
  const packaged = yield* HostProcessIsExecutable;
  const processEnvironment = yield* HostProcessEnvironment;
  const commandArgv = yield* encodeCommandArgv([
    executable,
    ...(packaged ? [] : [path.resolve(processArgs[1] ?? "")]),
    "remote",
    "login",
    "--base-dir",
    config.baseDir,
  ]).pipe(Effect.orDie);
  return SelfHostedEndpoint.of({
    getStatus: status,
    setup: Effect.sync(() => ({
      prompt: [
        "Set up persistent, user-owned Cloudflare remote access for this Supacode environment.",
        `Environment ID: ${environmentId}. Keep all commands on this host, including when connected through SSH.`,
        "Use the Supacode CLI matching this server's release; do not write a replacement tunnel installer.",
        "Run Supacode on this host with this argv array: " + commandArgv,
        ...(processEnvironment.ELECTRON_RUN_AS_NODE === "1"
          ? ["Set ELECTRON_RUN_AS_NODE=1 for this bundled desktop invocation."]
          : []),
        "The login subcommand installs the pinned cloudflared and opens Cloudflare's own login.",
        "The user chooses their Cloudflare domain in the browser. A domain in Cloudflare DNS is required.",
        "Reuse an existing cloudflared login only if it belongs to the intended account/domain. Never overwrite or delete an existing certificate.",
        "If management authorization was revoked, use remote login --renew with the same base-dir. It retains a backup and restores the previous certificate if login fails. Choose the same Cloudflare account and domain.",
        "After login, call supacode_remote_access with action configure. Its default certificate location is the runtime user's cloudflared certificate.",
        "Use action status to verify the endpoint. Create pairing through Connections once it is connected.",
        "Keep certificates and connector tokens on this host. Never print, paste, or upload their contents.",
        "The server owns the connector after setup. Explain repair, disable/re-enable, and removal in Connections.",
        `Installer schema version: 1. cloudflared version: ${RelayClient.CLOUDFLARED_VERSION}.`,
      ].join("\n"),
    })),
    configure: (input) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const previous = yield* guard;
            if (previous?.removalPending)
              return yield* new SelfHostedRemoteAccessError({ reason: "cleanup-pending" });
            yield* validateOrigin;
            const { login, zone } = yield* api(input.certificatePath ?? previous?.certificatePath);
            if (
              previous !== null &&
              (previous.accountId !== login.accountId || previous.zoneId !== login.zoneId)
            )
              return yield* new SelfHostedRemoteAccessError({ reason: "account-mismatch" });
            yield* save(
              previous
                ? { ...previous, certificatePath: login.certificatePath }
                : {
                    version: 1,
                    installationId: yield* crypto.randomUUIDv4,
                    environmentId,
                    accountId: login.accountId,
                    zoneId: login.zoneId,
                    zoneName: zone.name,
                    certificatePath: login.certificatePath,
                    enabled: true,
                    removalPending: false,
                    endpoint: null,
                    runtime: null,
                    origin: null,
                  },
            );
            return yield* repair;
          }),
        )
        .pipe(Effect.catch(failed)),
    setEnabled: (enabled) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const saved = yield* guard;
            if (saved === null)
              return yield* new SelfHostedRemoteAccessError({ reason: "not-configured" });
            if (saved.removalPending)
              return yield* new SelfHostedRemoteAccessError({ reason: "cleanup-pending" });
            const next = { ...saved, enabled };
            yield* save(next);
            if (!enabled) {
              ready = false;
              yield* publishEndpoint;
              yield* runtime.applyConfig(null);
              state = "disabled";
              failure = null;
            } else if (next.runtime !== null && sameOrigin(next)) yield* start(next);
            else return yield* repair;
            return yield* status;
          }),
        )
        .pipe(Effect.catch(failed)),
    repair: lock.withPermits(1)(repair),
    remove: lock
      .withPermits(1)(
        Effect.gen(function* () {
          const saved = yield* guard;
          if (saved === null) return yield* status;
          yield* save({ ...saved, enabled: false, removalPending: true });
          ready = false;
          state = "cleanup-pending";
          yield* publishEndpoint;
          yield* runtime.applyConfig(null);
          yield* withProvider(saved, (provider) =>
            Effect.gen(function* () {
              const provisioner = yield* Effect.promise(
                () => import("@supacode/relay/provisioner"),
              );
              const cleanup = yield* provisioner.LocalRemoval;
              yield* cleanup.prepare;
              const target = yield* provider.prepareDeprovision({
                userId: `${saved.accountId}:${saved.installationId}`,
                environmentId,
              });
              const removed = yield* provider.deprovision({
                userId: `${saved.accountId}:${saved.installationId}`,
                environmentId,
                ...(target === null ? {} : { target }),
              });
              if (!removed)
                return yield* new SelfHostedRemoteAccessError({ reason: "cleanup-pending" });
            }),
          );
          yield* secrets
            .remove(INSTALLATION_SECRET)
            .pipe(
              Effect.mapError(
                () => new SelfHostedRemoteAccessError({ reason: "operation-failed" }),
              ),
            );
          installation = null;
          state = "unconfigured";
          failure = null;
          return yield* status;
        }),
      )
      .pipe(Effect.catch(failed)),
    initialize,
    publicEndpoint: SubscriptionRef.get(publishedEndpoint),
    publicEndpointChanges: SubscriptionRef.changes(publishedEndpoint),
  });
});

export const layer = Layer.effect(SelfHostedEndpoint, make);
