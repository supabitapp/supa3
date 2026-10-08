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

export const make = Effect.gen(function* () {
  const endpoints = new Map<
    string,
    Promise<{ readonly origin: string; readonly close: () => Promise<void> }>
  >();
  const closing = new Map<string, Promise<void>>();
  const stop = Effect.fn("DesktopRelayGateway.stop")((address: string) =>
    Effect.tryPromise({
      try: async () => {
        if (closing.has(address)) return closing.get(address);
        const endpoint = endpoints.get(address);
        if (!endpoint) return;
        endpoints.delete(address);
        const closed = endpoint
          .then(
            (value) => value.close(),
            () => {},
          )
          .finally(() => closing.delete(address));
        closing.set(address, closed);
        await closed;
      },
      catch: (cause) => new DesktopRelayError({ operation: "stop", cause }),
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...endpoints.keys()], stop, { discard: true }).pipe(Effect.ignore),
  );
  const start = Effect.fn("DesktopRelayGateway.start")((address: string) =>
    Effect.tryPromise({
      try: async () => {
        await closing.get(address);
        if (!parseRelayAddress(address)) throw new Error("Not a relay identity address");
        if (endpoints.size >= 64 && !endpoints.has(address))
          throw new Error("Too many relay environments");
        const saved = endpoints.get(address);
        if (saved) return (await saved).origin;
        const created = openLoopbackRelay(address, {
          relayUrl: PUBLIC_RELAY_URL,
          randomBytes: NodeCrypto.randomBytes,
          createSocket: (url) => new WebSocket(url),
        });
        endpoints.set(address, created);
        try {
          return (await created).origin;
        } catch (error) {
          if (endpoints.get(address) === created) endpoints.delete(address);
          throw error;
        }
      },
      catch: (cause) => new DesktopRelayError({ operation: "start", cause }),
    }),
  );
  return DesktopRelayGateway.of({ start, stop });
});

export const layer = Layer.effect(DesktopRelayGateway, make);
