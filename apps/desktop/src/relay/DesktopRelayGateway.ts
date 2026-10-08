// @effect-diagnostics nodeBuiltinImport:off - native loopback endpoint for Electron's HTTP loaders.
import * as NodeCrypto from "node:crypto";
import { openLoopbackRelay } from "@supacode/shared/relay/tunnelNode";
import { parseRelayAddress, PUBLIC_RELAY_URL } from "@supacode/shared/relay/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class DesktopRelayError extends Schema.TaggedError<DesktopRelayError>()(
  "DesktopRelayError",
  {
    operation: Schema.Literals(["start", "stop"]),
    cause: Schema.Defect(),
  },
) {}

export class DesktopRelayGateway extends Context.Service<
  DesktopRelayGateway,
  {
    readonly start: (address: string) => Effect.Effect<string, DesktopRelayError>;
    readonly stop: (address: string) => Effect.Effect<void, DesktopRelayError>;
  }
>()("@supacode/desktop/relay/DesktopRelayGateway") {}

const make = Effect.gen(function* () {
  type Endpoint = {
    resource: Promise<Awaited<ReturnType<typeof openLoopbackRelay>>>;
    closing?: Promise<void>;
  };
  const endpoints = new Map<string, Endpoint>();
  const closing = new Map<string, Promise<void>>();
  let disposed = false;
  const closeResource = (address: string, endpoint: Endpoint) => {
    if (!endpoint.closing) {
      if (endpoints.get(address) === endpoint) endpoints.delete(address);
      const closed = endpoint.resource
        .then(
          (value) => value.close(),
          () => {},
        )
        .finally(() => {
          if (closing.get(address) === closed) closing.delete(address);
        });
      endpoint.closing = closed;
      closing.set(address, closed);
    }
    return endpoint.closing;
  };
  const stop = Effect.fn("DesktopRelayGateway.stop")((address: string) =>
    Effect.tryPromise({
      try: () => {
        const endpoint = endpoints.get(address);
        return endpoint
          ? closeResource(address, endpoint)
          : (closing.get(address) ?? Promise.resolve());
      },
      catch: (cause) => new DesktopRelayError({ operation: "stop", cause }),
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      disposed = true;
      await Promise.allSettled([
        ...[...endpoints].map(([address, endpoint]) => closeResource(address, endpoint)),
        ...closing.values(),
      ]);
    }),
  );
  const start = Effect.fn("DesktopRelayGateway.start")((address: string) =>
    Effect.tryPromise({
      try: async () => {
        if (!parseRelayAddress(address)) throw new Error("Not a relay identity address");
        if (disposed) throw new Error("Desktop relay gateway is closed");
        if (endpoints.size >= 64 && !endpoints.has(address))
          throw new Error("Too many relay environments");
        let endpoint = endpoints.get(address);
        if (!endpoint) {
          const created: Endpoint = {
            resource: (closing.get(address) ?? Promise.resolve())
              .catch(() => {})
              .then(() => {
                if (disposed || endpoints.get(address) !== created)
                  throw new Error("Desktop relay gateway was stopped before preparation");
                return openLoopbackRelay(address, {
                  relayUrl: PUBLIC_RELAY_URL,
                  randomBytes: NodeCrypto.randomBytes,
                  createSocket: (url) => new WebSocket(url),
                });
              })
              .catch((error) => {
                if (endpoints.get(address) === created) endpoints.delete(address);
                throw error;
              }),
          };
          endpoints.set(address, created);
          endpoint = created;
        }
        const selected = endpoint;
        const resource = await selected.resource;
        if (disposed || endpoints.get(address) !== selected)
          throw new Error("Desktop relay gateway was stopped during preparation");
        return resource.origin;
      },
      catch: (cause) => new DesktopRelayError({ operation: "start", cause }),
    }),
  );
  return DesktopRelayGateway.of({ start, stop });
});

export const layer = Layer.effect(DesktopRelayGateway, make);
