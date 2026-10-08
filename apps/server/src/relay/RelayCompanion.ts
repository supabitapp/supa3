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
        owners: Map<string, { pending: number; retained: boolean }>;
        closing?: Promise<void>;
      };
      const endpoints = new Map<string, Endpoint>();
      const closing = new Set<Promise<void>>();
      let disposed = false;
      const canonical = (address: string) => {
        const identity = canonicalRelayAddress(address);
        if (!identity) throw new Error("Not a relay address");
        return identity;
      };
      const closeResource = (address: string, endpoint: Endpoint) => {
        if (!endpoint.closing) {
          const closed = endpoint.resource
            .then(
              (value) => value.close(),
              () => {},
            )
            .finally(() => {
              if (endpoints.get(address) === endpoint) endpoints.delete(address);
              closing.delete(closed);
            });
          endpoint.closing = closed;
          closing.add(closed);
        }
        return endpoint.closing;
      };
      const close = Effect.fn("RelayCompanion.close")((address: string, owner: string) =>
        Effect.tryPromise({
          try: async () => {
            address = canonical(address);
            const endpoint = endpoints.get(address);
            if (!endpoint?.owners.delete(owner)) return;
            if (endpoint.owners.size === 0) await closeResource(address, endpoint);
          },
          catch: (cause) => new RelayCompanionError({ operation: "close", cause }),
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          disposed = true;
          await Promise.allSettled([
            ...[...endpoints].map(([address, endpoint]) => closeResource(address, endpoint)),
            ...closing,
          ]);
        }),
      );
      const openResource = async (
        address: string,
        owner: string,
        signal: AbortSignal,
      ): Promise<string> => {
        address = canonical(address);
        signal.throwIfAborted();
        if (disposed) throw new Error("Relay companion is closed");
        const saved = endpoints.get(address);
        let endpoint = saved;
        if (!endpoint || endpoint.closing) {
          if (!saved && endpoints.size >= 64) throw new Error("Too many relay environments");
          const created: Endpoint = {
            resource: (saved?.closing ?? Promise.resolve())
              .catch(() => {})
              .then(() => {
                if (disposed || created.closing || endpoints.get(address) !== created)
                  throw new Error("Relay endpoint was closed before preparation");
                return openLoopbackRelay(address, {
                  relayUrl,
                  randomBytes: NodeCrypto.randomBytes,
                  createSocket: (url) => new WebSocket(url),
                });
              })
              .catch((error) => {
                if (endpoints.get(address) === created) endpoints.delete(address);
                throw error;
              }),
            owners: new Map(),
          };
          endpoints.set(address, created);
          endpoint = created;
        }
        const selected = endpoint;
        const lease = selected.owners.get(owner) ?? { pending: 0, retained: false };
        selected.owners.set(owner, lease);
        lease.pending++;
        let pending = true;
        const finish = (retained = false) => {
          if (!pending) return;
          pending = false;
          lease.pending--;
          if (retained) lease.retained = true;
          if (!lease.retained && lease.pending === 0 && selected.owners.get(owner) === lease) {
            selected.owners.delete(owner);
            if (selected.owners.size === 0) void closeResource(address, selected).catch(() => {});
          }
        };
        const cancel = () => finish();
        signal.addEventListener("abort", cancel, { once: true });
        try {
          const resource = await selected.resource;
          signal.throwIfAborted();
          if (
            disposed ||
            selected.closing ||
            endpoints.get(address) !== selected ||
            selected.owners.get(owner) !== lease
          )
            throw new Error("Relay endpoint was closed during preparation");
          finish(true);
          return resource.origin;
        } finally {
          signal.removeEventListener("abort", cancel);
          finish();
        }
      };
      const open = Effect.fn("RelayCompanion.open")((address: string, owner: string) =>
        Effect.tryPromise({
          try: (signal) => openResource(address, owner, signal),
          catch: (cause) => new RelayCompanionError({ operation: "open", cause }),
        }),
      );
      return RelayCompanion.of({ open, close });
    }),
  );
}
