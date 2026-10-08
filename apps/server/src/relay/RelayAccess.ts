import { PUBLIC_RELAY_URL } from "@supacode/shared/relay/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import { RelayIdentity } from "./RelayIdentity.ts";
import { RelayIngress } from "./RelayIngress.ts";
import { startRelayTransport } from "./transport.ts";

export class RelayAccess extends Context.Service<
  RelayAccess,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("supacode/relay/RelayAccess") {}

export const make = Effect.gen(function* () {
  const identity = yield* RelayIdentity;
  const ingress = yield* RelayIngress;
  const settings = yield* ServerSettings.ServerSettingsService;
  const start = Effect.gen(function* () {
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    let stop: (() => void) | undefined;
    const apply = (enabled: boolean) =>
      Effect.sync(() => {
        if (enabled && !stop)
          stop = startRelayTransport({
            secret: identity.secret,
            relayUrl: PUBLIC_RELAY_URL,
            acceptStream: ingress.accept,
            onStatus: (next) =>
              runFork(
                next === "registered"
                  ? Effect.logInfo("Public relay registered")
                  : next === "superseded"
                    ? Effect.logWarning(
                        "Public relay identity is active on another host; reconnect is stopped.",
                      )
                    : Effect.logDebug("Public relay state", { state: next }),
              ),
          });
        if (!enabled) {
          stop?.();
          stop = undefined;
        }
      });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stop?.();
      }),
    );
    const changes = yield* settings.subscribeChanges;
    yield* Stream.runForEach(changes, (value) => apply(value.publicRelayEnabled)).pipe(
      Effect.forkScoped,
    );
    yield* apply((yield* settings.getSettings.pipe(Effect.orDie)).publicRelayEnabled);
  });
  return RelayAccess.of({ start });
});

export const layer = Layer.effect(RelayAccess, make);
