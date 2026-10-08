// @effect-diagnostics nodeBuiltinImport:off - client-side loopback gateway adapts native TCP loaders.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { canonicalRelayAddress, PUBLIC_RELAY_URL } from "@supacode/shared/relay/protocol";
import { openLoopbackRelay } from "@supacode/shared/relay/tunnelNode";

export class RelayCompanionError extends Schema.TaggedError<RelayCompanionError>()(
  "RelayCompanionError",
  {
    operation: Schema.Literals(["open", "close"]),
    cause: Schema.Defect(),
  },
) {}

export class RelayCompanion extends Context.Service<
  RelayCompanion,
  {
    readonly open: (address: string, owner: string) => Effect.Effect<string, RelayCompanionError>;
    readonly close: (address: string, owner: string) => Effect.Effect<void, RelayCompanionError>;
  }
>()("supacode/relay/RelayCompanion") {}

export function layer(relayUrl = PUBLIC_RELAY_URL) {
  return Layer.effect(
    RelayCompanion,
    Effect.gen(function* () {
      type Endpoint = {
        resource: Promise<Awaited<ReturnType<typeof openLoopbackRelay>>>;
        owners: Set<string>;
        closing?: Promise<void>;
      };
      const endpoints = new Map<string, Endpoint>();
      const canonical = (address: string) => {
        const identity = canonicalRelayAddress(address);
        if (!identity) throw new Error("Not a relay address");
        return identity;
      };
      const closeResource = (address: string, endpoint: Endpoint) => {
        if (!endpoint.closing)
          endpoint.closing = endpoint.resource
            .then(
              (value) => value.close(),
              () => {},
            )
            .finally(() => {
              if (endpoints.get(address) === endpoint) endpoints.delete(address);
            });
        return endpoint.closing;
      };
      const close = Effect.fn("RelayCompanion.close")((address: string, owner: string) =>
        Effect.tryPromise({
          try: async () => {
            address = canonical(address);
            const endpoint = endpoints.get(address);
            if (!endpoint) return;
            endpoint.owners.delete(owner);
            if (endpoint.owners.size === 0) await closeResource(address, endpoint);
          },
          catch: (cause) => new RelayCompanionError({ operation: "close", cause }),
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await Promise.allSettled(
            [...endpoints].map(([address, endpoint]) => closeResource(address, endpoint)),
          );
        }),
      );
      const openResource = async (address: string, owner: string): Promise<string> => {
        address = canonical(address);
        const saved = endpoints.get(address);
        if (saved?.closing) {
          await saved.closing;
          return openResource(address, owner);
        }
        if (saved) {
          saved.owners.add(owner);
          return (await saved.resource).origin;
        }
        if (endpoints.size >= 64) throw new Error("Too many relay environments");
        const created: Endpoint = {
          resource: openLoopbackRelay(address, {
            relayUrl,
            randomBytes: NodeCrypto.randomBytes,
            createSocket: (url) => new WebSocket(url),
          }),
          owners: new Set([owner]),
        };
        endpoints.set(address, created);
        try {
          return (await created.resource).origin;
        } catch (error) {
          if (endpoints.get(address) === created) endpoints.delete(address);
          throw error;
        }
      };
      const open = Effect.fn("RelayCompanion.open")((address: string, owner: string) =>
        Effect.tryPromise({
          try: () => openResource(address, owner),
          catch: (cause) => new RelayCompanionError({ operation: "open", cause }),
        }),
      );
      return RelayCompanion.of({ open, close });
    }),
  );
}
