import { canonicalRelayAddress } from "@supacode/shared/relay/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ConnectionTransientError } from "../connection/model.ts";

export interface RelayClientEndpoint {
  readonly prepare: () => Promise<string>;
  readonly close: () => Promise<void>;
}

export class RelayGateway extends Context.Service<
  RelayGateway,
  {
    readonly resolve: (address: string) => Promise<string>;
    readonly release: (address: string) => Promise<void>;
    readonly fetch: typeof globalThis.fetch;
  }
>()("@supacode/client-runtime/relay/gateway/RelayGateway") {}

export function layer(input: {
  readonly open: (address: string) => Promise<RelayClientEndpoint>;
  readonly fetch: typeof globalThis.fetch;
}) {
  return Layer.effect(
    RelayGateway,
    Effect.gen(function* () {
      const endpoints = new Map<string, Promise<RelayClientEndpoint>>();
      const closing = new Map<string, Promise<void>>();
      let disposed = false;
      const key = canonicalRelayAddress;
      const endpoint = async (address: string): Promise<RelayClientEndpoint> => {
        const identity = key(address);
        if (!identity) throw new Error("Not a relay address");
        await closing.get(identity);
        if (disposed) throw new Error("Relay gateway closed");
        const existing = endpoints.get(identity);
        if (existing) return existing;
        const created = input.open(identity);
        endpoints.set(identity, created);
        void created.catch(() => {
          if (endpoints.get(identity) === created) endpoints.delete(identity);
        });
        return created;
      };
      const release = async (address: string) => {
        const identity = key(address);
        if (!identity) return;
        const activeClose = closing.get(identity);
        if (activeClose) return activeClose;
        const owned = endpoints.get(identity);
        if (!owned) return;
        endpoints.delete(identity);
        const stopped = owned
          .then(
            (value) => value.close(),
            () => {},
          )
          .catch(() => {})
          .finally(() => {
            if (closing.get(identity) === stopped) closing.delete(identity);
          });
        closing.set(identity, stopped);
        await stopped;
      };
      const prepare = async (address: string) => {
        const value = await endpoint(address);
        return value.prepare();
      };
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          disposed = true;
          const owned = [...endpoints.values()];
          endpoints.clear();
          await Promise.allSettled([
            ...closing.values(),
            ...owned.map(async (value) => (await value).close()),
          ]);
        }),
      );
      return RelayGateway.of({
        resolve: async (address) => (key(address) ? prepare(address) : address),
        release,
        fetch: async (request, init) => {
          const address = request instanceof Request ? request.url : String(request);
          if (!key(address)) return input.fetch(request, init);
          const origin = await prepare(address);
          const url = new URL(address);
          const target = new URL(origin);
          target.pathname = url.pathname;
          target.search = url.search;
          return input.fetch(
            request instanceof Request ? new Request(target, request) : target,
            init,
          );
        },
      });
    }),
  );
}

export const resolveRelayOrigin = Effect.fn("RelayGateway.resolveOrigin")(function* (
  address: string,
) {
  const gateway = yield* Effect.serviceOption(RelayGateway);
  if (Option.isNone(gateway)) return address;
  return yield* Effect.tryPromise({
    try: () => gateway.value.resolve(address),
    catch: (cause) =>
      new ConnectionTransientError({
        reason: "transport",
        detail: cause instanceof Error ? cause.message : "The relay tunnel could not be opened.",
      }),
  });
});

export const releaseRelayOrigin = Effect.fn("RelayGateway.releaseOrigin")(function* (
  address: string,
) {
  const gateway = yield* Effect.serviceOption(RelayGateway);
  if (Option.isSome(gateway))
    yield* Effect.sync(() => {
      void gateway.value.release(address).catch(() => {});
    });
});
