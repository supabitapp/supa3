import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";
import * as Provisioner from "./provisioner.ts";

import { cloudflare } from "./provisioner.test-fixture.ts";

const key = { userId: "account:installation", environmentId: "environment" };
const origin = { localHttpHost: "127.0.0.1", localHttpPort: 12345 };
const options = {
  accountId: "account",
  zoneId: "zone",
  zoneName: "example.test",
  installationId: "installation",
  ownerId: key.userId,
  environmentId: key.environmentId,
  token: Redacted.make("test-management-secret"),
};
const withCloud = <A, E, R>(
  cloud: ReturnType<typeof cloudflare>,
  filename: string,
  effect: Effect.Effect<A, E, R | Provisioner.ManagedEndpointProvider | Provisioner.LocalRemoval>,
) =>
  effect.pipe(
    Effect.provide(
      Provisioner.layer({ ...options, databasePath: filename }).pipe(
        Layer.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, cloud.fetch)),
          ),
        ),
      ),
    ),
  );
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  return { filename: path.join(directory, "allocations.sqlite"), cloud: cloudflare() };
});
const provision = Provisioner.ManagedEndpointProvider.pipe(
  Effect.flatMap((provider) => provider.provision({ ...key, origin })),
);
const remove = Effect.gen(function* () {
  yield* (yield* Provisioner.LocalRemoval).prepare;
  const provider = yield* Provisioner.ManagedEndpointProvider;
  const target = yield* provider.prepareDeprovision(key);
  return yield* provider.deprovision({ ...key, target });
});

describe("user-owned provisioner", () => {
  it.effect(
    "reuses the original provisioner across restart, origin changes and owned cleanup",
    () =>
      Effect.gen(function* () {
        const { cloud, filename } = yield* fixture;
        const first = yield* withCloud(cloud, filename, provision);
        const second = yield* withCloud(cloud, filename, provision);
        expect(second.endpoint).toEqual(first.endpoint);
        expect(second.runtime.tunnelId).toBe(first.runtime.tunnelId);
        expect(cloud.tunnels.size).toBe(1);
        expect(cloud.dns.size).toBe(1);
        yield* withCloud(
          cloud,
          filename,
          Provisioner.ManagedEndpointProvider.pipe(
            Effect.flatMap((provider) =>
              provider.provision({ ...key, origin: { ...origin, localHttpPort: 12346 } }),
            ),
          ),
        );
        const configs = cloud.requests.filter((r) => r.path.endsWith("/configurations"));
        expect(configs.at(-1)?.body).toMatchObject({
          config: {
            ingress: [{ service: "http://127.0.0.1:12346" }, { service: "http_status:404" }],
          },
        });
        cloud.tunnels.set("other", {
          id: "other",
          name: "someone-elses-tunnel",
          status: "inactive",
        });
        cloud.dns.set("other", {
          id: "other",
          name: "other.example.test",
          type: "CNAME",
          content: "other.cfargotunnel.com",
          comment: "other installation",
        });
        expect(yield* withCloud(cloud, filename, remove)).toBe(true);
        expect([...cloud.tunnels.keys()]).toEqual(["other"]);
        expect([...cloud.dns.keys()]).toEqual(["other"]);
        expect(yield* withCloud(cloud, filename, remove)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "recovers a tunnel whose creation response was lost without creating a second one",
    () =>
      Effect.gen(function* () {
        const { cloud, filename } = yield* fixture;
        cloud.setFailAfterCreate();
        yield* withCloud(cloud, filename, provision).pipe(Effect.flip);
        expect(cloud.tunnels.size).toBe(1);
        yield* withCloud(cloud, filename, provision);
        expect(
          cloud.requests.filter((r) => r.method === "POST" && r.path.endsWith("cfd_tunnel")),
        ).toHaveLength(1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes an unjournaled remote write and retries failed cleanup", () =>
    Effect.gen(function* () {
      const { cloud, filename } = yield* fixture;
      cloud.setFailAfterCreate();
      yield* withCloud(cloud, filename, provision).pipe(Effect.flip);
      expect(yield* withCloud(cloud, filename, remove)).toBe(true);
      expect(cloud.tunnels.size).toBe(0);
      yield* withCloud(cloud, filename, provision);
      cloud.setFailDelete(true);
      yield* withCloud(cloud, filename, remove).pipe(Effect.flip);
      expect(cloud.tunnels.size).toBe(1);
      cloud.setFailDelete(false);
      expect(yield* withCloud(cloud, filename, remove)).toBe(true);
      expect(cloud.tunnels.size).toBe(0);
      expect(cloud.dns.size).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to overwrite or delete an unrelated DNS record at the reserved hostname", () =>
    Effect.gen(function* () {
      const { cloud, filename } = yield* fixture;
      yield* withCloud(cloud, filename, provision);
      const record = [...cloud.dns.values()][0]!;
      cloud.dns.set(record.id, { ...record, comment: "not this installation" });
      yield* withCloud(cloud, filename, provision).pipe(Effect.flip);
      yield* withCloud(cloud, filename, remove).pipe(Effect.flip);
      expect(cloud.dns.get(record.id)?.comment).toBe("not this installation");
      expect(cloud.tunnels.size).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects non-loopback origins before making management requests", () =>
    Effect.gen(function* () {
      const { cloud, filename } = yield* fixture;
      yield* withCloud(
        cloud,
        filename,
        Provisioner.ManagedEndpointProvider.pipe(
          Effect.flatMap((provider) =>
            provider.provision({
              ...key,
              origin: { localHttpHost: "192.168.1.4", localHttpPort: 12345 },
            }),
          ),
        ),
      ).pipe(Effect.flip);
      expect(cloud.requests).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
