import {
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  ExecutionEnvironmentDescriptor,
  SelfHostedRemoteAccessStatus,
} from "@supacode/contracts";
import * as RelayClient from "@supacode/shared/relayClient";
import * as Crypto from "effect/Crypto";
import * as Exit from "effect/Exit";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as CloudflareCredentials from "../cloud/CloudflareCredentials.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class RemoteCommandFailed extends Schema.TaggedError<RemoteCommandFailed>()(
  "RemoteCommandFailed",
  {
    message: Schema.String,
  },
) {}

/** The agent and CLI call the running service, which owns the allocation lock. */
const run = Effect.fnUntraced(function* (
  flags: CliAuthLocationFlags,
  action: "status" | "configure" | "enable" | "disable" | "repair" | "remove",
  certificatePath?: string,
) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
  return yield* Effect.gen(function* () {
    const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(state))
      return yield* new RemoteCommandFailed({
        message: "Start this Supacode environment before managing remote access.",
      });
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const expected = yield* identity.getEnvironmentId;
    const http = yield* HttpClient.HttpClient;
    // Prove the persisted listener is still ours before sending any credential.
    const descriptor = yield* http
      .get(new URL("/.well-known/supacode/environment", state.value.origin).toString())
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
        Effect.timeout("5 seconds"),
      );
    if (descriptor.environmentId !== expected)
      return yield* new RemoteCommandFailed({
        message: "The saved listener belongs to another environment.",
      });
    const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: state.value.origin });
    return yield* Effect.acquireUseRelease(
      auth.issueSession({ scopes: AuthAdministrativeScopes, label: "supacode remote cli" }),
      (issued) => {
        const headers = { authorization: `Bearer ${issued.token}` };
        switch (action) {
          case "status":
            return client.remoteAccess.status({ headers });
          case "configure":
            return client.remoteAccess.configure({
              headers,
              payload: certificatePath ? { certificatePath } : {},
            });
          case "enable":
          case "disable":
            return client.remoteAccess.setEnabled({
              headers,
              payload: { enabled: action === "enable" },
            });
          case "repair":
            return client.remoteAccess.repair({ headers });
          case "remove":
            return client.remoteAccess.remove({ headers });
        }
      },
      (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config))),
        FetchHttpClient.layer,
      ),
    ),
    Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(SelfHostedRemoteAccessStatus))),
    Effect.flatMap(Console.log),
    Effect.catch(
      () =>
        new RemoteCommandFailed({
          message: "Remote access could not be updated. Check its status in Connections and retry.",
        }),
    ),
  );
});

export const runCloudflareLogin = Effect.fnUntraced(function* (renew = false) {
  const credentials = yield* CloudflareCredentials.CloudflareCredentials;
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(credentials.defaultCertificatePath);
  if (exists && !renew) {
    yield* credentials.read();
    yield* Console.log(
      "An existing cloudflared login is available. Configure remote access to verify its account and domain.",
    );
    return;
  }
  const relay = yield* RelayClient.RelayClient;
  const installed = yield* relay.install;
  const crypto = yield* Crypto.Crypto;
  const backup = exists
    ? `${credentials.defaultCertificatePath}.supacode-backup-${yield* crypto.randomUUIDv4}`
    : null;
  if (backup !== null) {
    yield* fs.rename(credentials.defaultCertificatePath, backup);
    yield* Console.log(`Previous Cloudflare login retained at ${backup}`);
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* Effect.gen(function* () {
    const process = yield* spawner.spawn(
      ChildProcess.make(installed.executablePath, ["tunnel", "login"], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    const code = yield* process.exitCode;
    if (code !== 0)
      return yield* new RemoteCommandFailed({
        message: "Cloudflare login did not complete. Run remote login again.",
      });
    yield* credentials.read();
  }).pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit) || backup === null) return Effect.void;
      return Effect.gen(function* () {
        if (yield* fs.exists(credentials.defaultCertificatePath))
          yield* fs.rename(credentials.defaultCertificatePath, `${backup}.failed-login`);
        yield* fs.rename(backup, credentials.defaultCertificatePath);
      }).pipe(Effect.orDie);
    }),
  );
  yield* Console.log(
    "Cloudflare login is stored locally. Run supacode remote configure for this Supacode home.",
  );
});

export const login = Effect.fnUntraced(function* (flags: CliAuthLocationFlags, renew = false) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
  return yield* runCloudflareLogin(renew).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudflareCredentials.layer,
        RelayClient.layerCloudflared({ baseDir: config.baseDir }).pipe(
          Layer.provideMerge(FetchHttpClient.layer),
        ),
      ),
    ),
  );
});

const certificatePath = Flag.String("certificate-path").pipe(
  Flag.optional,
  Flag.withDescription(
    "Existing cloudflared certificate on this host; its contents never cross the app API.",
  ),
);
const subcommands = (["status", "configure", "enable", "disable", "repair", "remove"] as const).map(
  (action) =>
    Command.make(action, { ...authLocationFlags, certificatePath }).pipe(
      Command.withDescription(
        action === "remove"
          ? "Remove this installation's Cloudflare tunnel and DNS record; retain unrelated resources and login."
          : `${action} user-owned remote access.`,
      ),
      Command.withHandler((flags) =>
        run(flags, action, Option.getOrUndefined(flags.certificatePath)),
      ),
    ),
);
export const remoteCommand = Command.make("remote").pipe(
  Command.withDescription("Manage persistent remote access in your own Cloudflare account."),
  Command.withSubcommands([
    Command.make("login", {
      ...authLocationFlags,
      renew: Flag.Boolean("renew").pipe(
        Flag.withDescription(
          "Preserve the previous certificate in a backup, then repeat Cloudflare login; restore it if login fails.",
        ),
        Flag.withDefault(false),
      ),
    }).pipe(
      Command.withDescription(
        "Open Cloudflare login on this host; reuse an existing certificate without changing it.",
      ),
      Command.withHandler((flags) => login(flags, flags.renew)),
    ),
    ...subcommands,
  ]),
);
