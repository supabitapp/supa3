import * as NetAddress from "effect/net/NetAddress";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@supacode/contracts";
import * as RelayClient from "@supacode/shared/relayClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpServer } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Activation from "../serverActivation.ts";
import * as Credentials from "./CloudflareCredentials.ts";
import * as Runtime from "./ManagedEndpointRuntime.ts";
import * as Endpoint from "./SelfHostedEndpoint.ts";
import { cloudflare } from "../../../../infra/relay/src/local/provisioner.test-fixture.ts";

const fixture = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const cloud = cloudflare();
  let installs = 0;
  let loginRequired = false;
  const configs: Parameters<Runtime.CloudManagedEndpointRuntime["Service"]["applyConfig"]>[0][] =
    [];
  const available = {
    status: "available" as const,
    executablePath: "test-cloudflared",
    source: "managed" as const,
    version: RelayClient.CLOUDFLARED_VERSION,
  };
  const deps = Layer.mergeAll(
    ServerConfig.layer(config),
    SecretStore.layer.pipe(Layer.provide(ServerConfig.layer(config))),
    Layer.succeed(Environment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
      getDescriptor: Effect.die("unused"),
    }),
    Layer.succeed(RelayClient.RelayClient, {
      resolve: Effect.succeed(available),
      install: Effect.sync(() => {
        installs++;
        return available;
      }),
      installWithProgress: () => Effect.die("unused"),
    }),
    Layer.succeed(Credentials.CloudflareCredentials, {
      defaultCertificatePath: "test-cert",
      read: () =>
        Effect.suspend(() =>
          loginRequired
            ? new Credentials.CloudflareLoginRequired()
            : Effect.succeed({
                accountId: "account",
                zoneId: "zone",
                certificatePath: "test-cert",
                token: Redacted.make("test-management-secret"),
              }),
        ),
    }),
    Layer.succeed(Runtime.CloudManagedEndpointRuntime, {
      applyConfig: (config) =>
        Effect.sync(() => {
          configs.push(config);
          return config
            ? { status: "running" as const, providerKind: "cloudflare_tunnel" as const, pid: 123 }
            : { status: "disabled" as const };
        }),
      recoveryRequests: Stream.empty,
      tunnelConnected: Stream.empty,
      requestRecovery: () => Effect.void,
      withLinkStateLock: (effect) => effect,
    }),
    Layer.mock(HttpServer.HttpServer)({
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 12345),
    }),
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, cloud.fetch))),
    Layer.succeed(Activation.ServerActivation, Effect.never),
  );
  const build = Endpoint.make.pipe(Effect.provide(deps));
  return {
    cloud,
    build,
    configs,
    installs: () => installs,
    invalidateLogin: () => {
      loginRequired = true;
    },
  };
});
const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "supacode-owned-connect-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

describe("SelfHostedEndpoint", () => {
  it.effect("leaves an unconfigured host offline and returns a versioned setup prompt", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const endpoint = yield* f.build;
      yield* endpoint.initialize;
      expect(yield* endpoint.getStatus).toMatchObject({
        state: "unconfigured",
        enabled: false,
        publicUrl: null,
      });
      expect(f.cloud.requests).toEqual([]);
      expect(f.installs()).toBe(0);
      expect((yield* endpoint.setup).prompt).toContain("Installer schema version: 1");
      expect((yield* endpoint.setup).prompt).toContain('"remote","login","--base-dir"');
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "verifies readiness, preserves the URL across restart and disable, and removes only owned resources",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const endpoint = yield* f.build;
        const status = yield* endpoint.configure({});
        expect(status.state).toBe("connected");
        expect(yield* encodeJson(status)).not.toContain("test-connector-secret");
        expect(yield* endpoint.publicEndpoint).toBe(status.publicUrl);
        yield* endpoint.setEnabled(false);
        expect(yield* endpoint.publicEndpoint).toBeNull();
        expect(f.configs.at(-1)).toBeNull();
        expect(f.cloud.tunnels.size).toBe(1);
        const restarted = yield* f.build;
        yield* restarted.initialize;
        expect((yield* restarted.getStatus).state).toBe("disabled");
        const managementCalls = f.cloud.requests.length;
        yield* restarted.setEnabled(true);
        expect(f.cloud.requests).toHaveLength(managementCalls);
        expect((yield* restarted.getStatus).publicUrl).toBe(status.publicUrl);
        f.cloud.setFailDelete(true);
        yield* restarted.remove.pipe(Effect.flip);
        expect(yield* restarted.getStatus).toMatchObject({
          state: "cleanup-pending",
          enabled: false,
        });
        expect(yield* restarted.publicEndpoint).toBeNull();
        yield* restarted.configure({}).pipe(Effect.flip);
        f.cloud.setFailDelete(false);
        expect((yield* restarted.remove).state).toBe("unconfigured");
        expect(f.cloud.tunnels.size).toBe(0);
        expect(f.cloud.dns.size).toBe(0);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes readiness and withdrawal to existing clients", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const endpoint = yield* f.build;
      const subscribed = yield* Deferred.make<void>();
      const changes = yield* endpoint.publicEndpointChanges.pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      const connected = yield* endpoint.configure({});
      yield* endpoint.setEnabled(false);
      expect(yield* Fiber.join(changes)).toEqual([null, connected.publicUrl, null]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "restarts an enabled connector without management credentials and retains failed removal",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const endpoint = yield* f.build;
        yield* endpoint.configure({});
        const requests = f.cloud.requests.length;
        f.invalidateLogin();
        const restarted = yield* f.build;
        yield* restarted.initialize;
        expect((yield* restarted.getStatus).state).toBe("connected");
        expect(f.cloud.requests).toHaveLength(requests);
        yield* restarted.repair.pipe(Effect.flip);
        expect((yield* restarted.getStatus).state).toBe("needs-login");
        expect((yield* restarted.getStatus).ready).toBe(true);
        expect(yield* restarted.publicEndpoint).not.toBeNull();
        yield* restarted.remove.pipe(Effect.flip);
        expect(yield* restarted.getStatus).toMatchObject({
          state: "cleanup-pending",
          enabled: false,
        });
        const next = yield* f.build;
        yield* next.initialize;
        expect((yield* next.getStatus).state).toBe("cleanup-pending");
      }).pipe(Effect.provide(testLayer)),
  );
});
