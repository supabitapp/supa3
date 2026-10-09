import { DEFAULT_PUBLIC_RELAY_URL } from "@supacode/contracts";
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
    readonly resolve: (address: string, relayUrl?: string) => Promise<string>;
    readonly release: (address: string) => Promise<void>;
    readonly fetch: typeof globalThis.fetch;
  }
>()("@supacode/client-runtime/relay/gateway/RelayGateway") {}

export function layer(input: {
  readonly open: (address: string, relayUrl: string) => Promise<RelayClientEndpoint>;
  readonly fetch: typeof globalThis.fetch;
}) {
  return Layer.effect(
    RelayGateway,
    Effect.gen(function* () {
      const endpoints = new Map<
        string,
        { readonly relayUrl: string; readonly endpoint: Promise<RelayClientEndpoint> }
      >();
      const relayUrls = new Map<string, string>();
      const closing = new Map<string, Promise<void>>();
      let disposed = false;
      const key = canonicalRelayAddress;
      const release = async (address: string) => {
        const identity = key(address);
        if (!identity) return;
        const activeClose = closing.get(identity);
        if (activeClose) return activeClose;
        const owned = endpoints.get(identity);
        if (!owned) return;
        endpoints.delete(identity);
        const stopped = owned.endpoint
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
      const endpoint = async (identity: string): Promise<RelayClientEndpoint> => {
        const relayUrl = relayUrls.get(identity) ?? DEFAULT_PUBLIC_RELAY_URL;
        const existing = endpoints.get(identity);
        if (existing && existing.relayUrl !== relayUrl) await release(identity);
        await closing.get(identity);
        if (disposed) throw new Error("Relay gateway closed");
        const current = endpoints.get(identity);
        if (current) return current.endpoint;
        const created = input.open(identity, relayUrl);
        endpoints.set(identity, { relayUrl, endpoint: created });
        void created.catch(() => {
          if (endpoints.get(identity)?.endpoint === created) endpoints.delete(identity);
        });
        return created;
      };
      const prepare = async (identity: string) => (await endpoint(identity)).prepare();
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          disposed = true;
          const owned = [...endpoints.values()];
          endpoints.clear();
          await Promise.allSettled([
            ...closing.values(),
            ...owned.map(async (value) => (await value.endpoint).close()),
          ]);
        }),
      );
      return RelayGateway.of({
        resolve: async (address, relayUrl) => {
          const identity = key(address);
          if (!identity) return address;
          if (relayUrl !== undefined) relayUrls.set(identity, relayUrl);
          return prepare(identity);
        },
        release,
        fetch: async (request, init) => {
          const address = request instanceof Request ? request.url : String(request);
          const identity = key(address);
          if (!identity) return input.fetch(request, init);
          const origin = await prepare(identity);
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
  relayUrl?: string,
) {
  const gateway = yield* Effect.serviceOption(RelayGateway);
  if (Option.isNone(gateway)) return address;
  return yield* Effect.tryPromise({
    try: () => gateway.value.resolve(address, relayUrl),
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
