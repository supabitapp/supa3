import * as NodeSqliteClient from "@supacode/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as Configuration from "../environments/ManagedEndpointConfiguration.ts";
import * as Provider from "../environments/ManagedEndpointProvider.ts";
import * as Limits from "../environments/ManagedTunnelLimits.ts";
import * as Allocations from "./LocalAllocations.ts";
import * as Clients from "./CloudflareClients.ts";

export class LocalRemoval extends Context.Service<
  LocalRemoval,
  {
    readonly prepare: Effect.Effect<
      void,
      Effect.Error<ReturnType<typeof Clients.recoverForRemoval>>
    >;
  }
>()("@supacode/relay/local/provisioner/LocalRemoval") {}

export const layer = (input: {
  readonly accountId: string;
  readonly zoneId: string;
  readonly zoneName: string;
  readonly installationId: string;
  readonly ownerId: string;
  readonly environmentId: string;
  readonly databasePath: string;
  readonly token: Redacted.Redacted<string>;
}) => {
  const allocations = Allocations.layer.pipe(
    Layer.provide(NodeSqliteClient.layer({ filename: input.databasePath })),
  );
  const clients = Layer.effectContext(
    Effect.gen(function* () {
      const { tunnels, dns } = yield* Clients.makeClients(input);
      return Context.make(Provider.ManagedEndpointTunnelClient, tunnels).pipe(
        Context.add(Provider.ManagedEndpointDnsClient, dns),
      );
    }),
  ).pipe(Layer.provide(allocations), Layer.provide(Clients.layerApi(input.token)));
  const limits = Layer.succeed(
    Limits.ManagedTunnelLimits,
    Limits.ManagedTunnelLimits.of({
      ensureCapacity: (key) =>
        key.userId === input.ownerId && key.environmentId === input.environmentId
          ? Effect.void
          : Effect.fail(
              new Limits.ManagedTunnelLimitExceeded({ ...key, maxTunnels: 1, activeTunnels: 1 }),
            ),
    }),
  );
  const removal = Layer.effect(
    LocalRemoval,
    Effect.gen(function* () {
      const context =
        yield* Effect.context<Effect.Services<ReturnType<typeof Clients.recoverForRemoval>>>();
      return { prepare: Clients.recoverForRemoval(input).pipe(Effect.provide(context)) };
    }),
  ).pipe(Layer.provide(clients), Layer.provide(allocations));
  return Provider.layer.pipe(
    Layer.provideMerge(removal),
    Layer.provide(clients),
    Layer.provide(allocations),
    Layer.provide(limits),
    Layer.provide(
      Layer.succeed(Configuration.ManagedEndpointConfiguration, {
        managedEndpointBaseDomain: input.zoneName,
        managedEndpointNamespace: "supacode",
      }),
    ),
  );
};

export { ManagedEndpointProvider } from "../environments/ManagedEndpointProvider.ts";
export { CloudflareApi, CloudflareApiError, layerApi } from "./CloudflareClients.ts";
